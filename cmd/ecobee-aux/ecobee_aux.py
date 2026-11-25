#!/usr/bin/env python3
"""Use a PWUsage On-Peak bank to manage a fuel-fired ecobee Aux mode."""

import argparse
import fcntl
import hashlib
import json
import logging
import math
import os
import re
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from getpass import getpass
from http.client import HTTPException
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from pyecobee import (
    ECOBEE_ACCESS_TOKEN,
    ECOBEE_PASSWORD,
    ECOBEE_REFRESH_TOKEN,
    ECOBEE_USERNAME,
    Ecobee,
    EcobeeAuthMfaRequiredError,
)
from pyecobee.errors import EcobeeAuthFailedError, EcobeeError, InvalidTokenError

# The library can include tokens and upstream bodies in its own logs.
logging.getLogger("pyecobee").setLevel(logging.CRITICAL + 1)

AUX = "auxHeatOnly"
HEATING_MODES = ("heat", "auto")
ENABLE_CONFIRM_SECONDS = 600
RUN_ID = os.urandom(6).hex()


class ScriptError(Exception):
    pass


def log_event(event, **fields):
    print(json.dumps({
        "time": datetime.now(timezone.utc).isoformat(),
        "run_id": RUN_ID,
        "event": event,
        **fields,
    }), flush=True)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request_json(url, *, token, etag=None):
    headers = {"Accept": "application/json", "Authorization": f"Bearer {token}"}
    if etag:
        headers["If-None-Match"] = etag
    request = Request(url, headers=headers)
    try:
        response = build_opener(NoRedirect()).open(request, timeout=12)
    except HTTPError as error:
        response = error
    except (URLError, OSError, HTTPException):
        raise ScriptError("Request could not reach the service.") from None
    with response:
        try:
            payload = None if response.code == 304 else json.load(response)
        except (UnicodeError, ValueError):
            payload = None
        except (OSError, HTTPException):
            raise ScriptError("Request timed out while reading the response.") from None
        return response.code, payload, response.headers.get("ETag")


def fetch_service(name, url, **kwargs):
    try:
        return request_json(url, **kwargs)
    except ScriptError as error:
        raise ScriptError(f"{name}: {error}") from None


def save_state(path, state):
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as handle:
        temp = Path(handle.name)
        try:
            json.dump(state, handle)
            handle.flush()
            os.fsync(handle.fileno())
            temp.replace(path)
        finally:
            temp.unlink(missing_ok=True)


def load_state(path, thermostat_id):
    if not path.exists():
        return {"thermostat_id": thermostat_id}
    if path.stat().st_mode & 0o077:
        raise ScriptError("The state file must be private to its owner (chmod 600).")
    state = json.loads(path.read_text())
    if not isinstance(state, dict) or state.get("thermostat_id") != thermostat_id:
        raise ScriptError("Use a separate state file for each ecobee thermostat.")
    if state.get("previous_mode") not in (None, *HEATING_MODES):
        raise ScriptError("The state file contains an invalid restore mode.")
    return state


def required(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise ScriptError(f"Set {name}.")
    return value


def finite_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def as_object(value):
    return value if isinstance(value, dict) else {}


def timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else None


def period_key(name):
    return re.sub(r"[\s_-]+", " ", name.casefold()).strip()


@dataclass(frozen=True)
class BillingConfig:
    url: str
    token: str
    peak: str
    enter_kwh: float
    exit_kwh: float
    max_age_minutes: float

    @classmethod
    def load(cls):
        url = urlsplit(required("PWUSAGE_URL"))
        if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ScriptError("PWUSAGE_URL must be an HTTPS origin.")
        if url.path not in ("", "/"):
            raise ScriptError("PWUSAGE_URL must be an HTTPS origin.")
        try:
            enter = float(required("AUX_ENTER_KWH"))
            exit_at = float(required("AUX_EXIT_KWH"))
            max_age = float(os.environ.get("PWUSAGE_MAX_AGE_MINUTES", "60"))
        except ValueError:
            raise ScriptError("Bank thresholds and sample age must be numbers.") from None
        if not all(map(finite_number, (enter, exit_at, max_age))) or exit_at <= enter or max_age <= 0:
            raise ScriptError("Set AUX_EXIT_KWH above AUX_ENTER_KWH and use a positive sample age.")
        return cls(f"https://{url.netloc}/api/integrations/v1/billing", required("PWUSAGE_TOKEN"),
                   period_key(required("PWUSAGE_ON_PEAK_PERIOD")), enter, exit_at, max_age)


def fetch_bill(config, state, save):
    key = hashlib.sha256(f"{config.url}\0{config.token}".encode()).hexdigest()
    cached = state.get("billing", {})
    if cached.get("key") != key:
        cached = {}
    status, payload, etag = fetch_service("PWUsage", config.url, token=config.token, etag=cached.get("etag"))
    if status == 304 and isinstance(cached.get("payload"), dict):
        return cached["payload"], status
    if status != 200 or not isinstance(payload, dict):
        raise ScriptError(f"PWUsage did not return a bill (HTTP {status}).")
    state["billing"] = {"key": key, "etag": etag, "payload": payload}
    save()
    return payload, status


@dataclass(frozen=True)
class BankReading:
    condition: str
    bank_kwh: float | None = None
    active_period: str | None = None
    sample_age_seconds: float | None = None


def read_bank(payload, config, now):
    through = timestamp(as_object(payload.get("sources")).get("energyDataThrough"))
    age = round((now - through).total_seconds(), 1) if through is not None else None
    timing = as_object(payload.get("loadTiming"))
    prices = timing.get("pricingPeriods")
    if not isinstance(prices, list):
        return BankReading("active rate period unavailable", sample_age_seconds=age)
    active = [row for row in prices if isinstance(row, dict) and row.get("isActive") is True]
    if len(active) != 1 or not isinstance(active[0].get("name"), str):
        return BankReading("active rate period unavailable", sample_age_seconds=age)
    period = active[0]["name"]
    context = {"active_period": period, "sample_age_seconds": age}
    if period_key(period) != config.peak:
        if not any(isinstance(row, dict) and isinstance(row.get("name"), str)
                   and period_key(row["name"]) == config.peak for row in prices):
            return BankReading("configured On-Peak period is unavailable", **context)
        return BankReading("off-peak", **context)
    if as_object(payload.get("currentBill")).get("status") != "complete" or timing.get("hasCycleData") is not True:
        return BankReading("billing totals unavailable", **context)
    if through is None or not 0 <= (now - through).total_seconds() <= config.max_age_minutes * 60:
        return BankReading("PWUsage readings are stale or missing", **context)
    bank = active[0].get("cycleNetExportKwh")
    if not finite_number(bank):
        return BankReading("On-Peak bank unavailable", **context)
    return BankReading("on-peak", bank, **context)


class EcobeeThermostat:
    def __init__(self, thermostat_id, state, save):
        self.thermostat_id = thermostat_id
        self.state = state
        self.save = save
        tokens = as_object(state.get("ecobee_tokens"))
        self.client = Ecobee(config=tokens) if tokens.get(ECOBEE_REFRESH_TOKEN) else None

    def authorize(self):
        if not sys.stdin.isatty():
            raise ScriptError("Run --authorize in an interactive terminal.")
        username = input("ecobee account email: ").strip()
        password = getpass("ecobee account password: ")
        if not username or not password:
            raise ScriptError("Enter your ecobee account email and password.")
        login = Ecobee(config={ECOBEE_USERNAME: username, ECOBEE_PASSWORD: password})
        try:
            try:
                authorized = login.refresh_tokens()
            except EcobeeAuthMfaRequiredError as error:
                code = getpass("ecobee MFA code: ").strip()
                authorized = bool(code) and login.submit_mfa_code(error.challenge, code)
        except EcobeeAuthFailedError:
            raise ScriptError("ecobee rejected the sign-in or MFA code.") from None
        except EcobeeError:
            raise ScriptError("Could not complete ecobee sign-in.") from None
        if not authorized or not login.access_token or not login.refresh_token:
            raise ScriptError("ecobee did not return reusable credentials.")
        self.client = Ecobee(config={
            ECOBEE_ACCESS_TOKEN: login.access_token, ECOBEE_REFRESH_TOKEN: login.refresh_token,
        })
        self.persist_tokens()
        mode, _, _ = self.read()
        log_event("ecobee_authorized", mode=mode)

    def persist_tokens(self):
        if not self.client.refresh_token:
            return
        tokens = {
            ECOBEE_ACCESS_TOKEN: self.client.access_token,
            ECOBEE_REFRESH_TOKEN: self.client.refresh_token,
        }
        if self.state.get("ecobee_tokens") != tokens:
            self.state["ecobee_tokens"] = tokens
            self.save()

    def call(self, method, *args):
        if self.client is None:
            raise ScriptError("Run --authorize to connect your ecobee account.")
        try:
            if not self.client.access_token and not self.client.refresh_tokens():
                raise ScriptError("ecobee did not refresh the access token.")
            return getattr(self.client, method)(*args)
        except InvalidTokenError:
            raise ScriptError("ecobee authorization expired. Run --authorize again.") from None
        except EcobeeError:
            raise ScriptError("The ecobee request failed. Check service connectivity.") from None
        finally:
            # An API call can rotate the token before a subsequent request fails.
            self.persist_tokens()

    def thermostat_index(self):
        thermostats = self.client.thermostats or []
        matches = [index for index, thermostat in enumerate(thermostats)
                   if as_object(thermostat).get("identifier") == self.thermostat_id]
        if len(matches) != 1:
            raise ScriptError("ecobee did not return the configured thermostat.")
        return matches[0]

    def read(self):
        if not self.call("get_thermostats"):
            raise ScriptError("ecobee did not return thermostat data.")
        thermostat = self.client.thermostats[self.thermostat_index()]
        if as_object(thermostat.get("runtime")).get("connected") is not True:
            raise ScriptError("The ecobee thermostat is offline.")
        settings = as_object(thermostat.get("settings"))
        mode = settings.get("hvacMode")
        if mode not in (*HEATING_MODES, AUX, "cool", "off"):
            raise ScriptError("ecobee returned an unsupported HVAC mode.")
        equipment = thermostat.get("equipmentStatus")
        equipment = equipment.split(",") if isinstance(equipment, str) else []
        heating = any(item.strip() in ("heatPump", "heatPump2", "heatPump3") for item in equipment)
        return mode, settings.get("hasHeatPump") is True, heating

    def set_mode(self, mode):
        index = self.thermostat_index()
        log_event("ecobee_mode_change_requested", target_mode=mode)
        self.call("set_hvac_mode", index, mode)
        observed, _, _ = self.read()
        if observed != mode:
            log_event("ecobee_mode_change_unconfirmed", target_mode=mode, observed_mode=observed)
            raise ScriptError("ecobee has not reported the requested mode yet.")
        log_event("ecobee_mode_change_confirmed", observed_mode=observed)


def reconcile(ecobee, state, save, *, condition, bank, config, apply):
    previous_mode = state.get("previous_mode")
    eligible = bank is not None and bank <= config.enter_kwh
    restore = previous_mode and (state.get("restore_pending") or bank is None or bank >= config.exit_kwh)
    if condition in ("off-peak", "scheduled restore") and apply and state.pop("manual_override", False):
        save()

    if apply and not previous_mode and (not eligible or state.get("manual_override")):
        return "no change"
    mode, has_heat_pump, heating = ecobee.read()
    log_event("ecobee_mode_observed", mode=mode, has_heat_pump=has_heat_pump, heat_pump_running=heating,
              restore_mode=previous_mode)

    if previous_mode:
        if mode != AUX:
            requested_at = state.get("enable_requested_at")
            if mode == previous_mode and finite_number(requested_at) and time.time() - requested_at < ENABLE_CONFIRM_SECONDS:
                return "awaiting Aux confirmation"
            if apply:
                state.pop("previous_mode")
                state.pop("enable_requested_at", None)
                restored = state.pop("restore_pending", False) and mode == previous_mode
                state["manual_override"] = not restored and condition not in ("off-peak", "scheduled restore")
                save()
                if restored:
                    return f"confirmed restore to {mode}"
            return f"kept existing {mode} mode"
        if apply and state.pop("enable_requested_at", None) is not None:
            save()
        if restore:
            if apply:
                state["restore_pending"] = True
                save()
                ecobee.set_mode(previous_mode)
            return f"{'requested restore to' if apply else 'would restore'} {previous_mode}"
        return "kept script-managed Aux"
    if not eligible or state.get("manual_override"):
        return f"kept existing {mode} mode"
    if not has_heat_pump or mode not in HEATING_MODES or (mode == "auto" and not heating):
        return f"kept existing {mode} mode"
    if apply:
        state["previous_mode"] = mode
        state["enable_requested_at"] = time.time()
        save()
        ecobee.set_mode(AUX)
        state.pop("enable_requested_at")
        save()
    return f"{'requested' if apply else 'would request'} Aux from {mode}"


def run(args, state, ecobee, save):
    apply = args.apply or args.restore
    config = None if args.restore else BillingConfig.load()
    failure = None
    http_status = None
    if args.restore:
        if not state.get("previous_mode") and not state.get("manual_override"):
            return 0
        reading = BankReading("scheduled restore")
    else:
        try:
            payload, http_status = fetch_bill(config, state, save)
            reading = read_bank(payload, config, datetime.now(timezone.utc))
        except ScriptError as error:
            failure = error
            reading = BankReading(str(error))
    log_event("evaluation", mode="apply" if apply else "dry_run", condition=reading.condition,
              billing_http_status=http_status, active_period=reading.active_period, bank_kwh=reading.bank_kwh,
              sample_age_seconds=reading.sample_age_seconds, restore_mode=state.get("previous_mode"),
              manual_override=state.get("manual_override", False),
              enter_kwh=config.enter_kwh if config else None, exit_kwh=config.exit_kwh if config else None)
    action = reconcile(ecobee, state, save, condition=reading.condition, bank=reading.bank_kwh,
                       config=config, apply=apply)
    log_event("completed", action=action, exit_code=1 if failure else 0)
    return 1 if failure else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_mutually_exclusive_group()
    commands.add_argument("--authorize", action="store_true", help="sign in to your ecobee account")
    commands.add_argument("--apply", action="store_true", help="let the script set and restore HVAC mode")
    commands.add_argument("--restore", action="store_true", help="restore a script-managed mode without polling PWUsage")
    args = parser.parse_args()
    try:
        thermostat_id = required("ECOBEE_THERMOSTAT_ID")
        if not re.fullmatch(r"[0-9]+", thermostat_id):
            raise ScriptError("ECOBEE_THERMOSTAT_ID must identify one thermostat.")
        path = Path(os.environ.get("ECOBEE_AUX_STATE", "~/.local/state/pwusage-ecobee/pyecobee-state.json")).expanduser()
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.umask(0o077)
        with path.with_suffix(path.suffix + ".lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | (0 if args.restore else fcntl.LOCK_NB))
            except BlockingIOError:
                log_event("skipped", reason="another run holds the state lock")
                return 0
            state = load_state(path, thermostat_id)

            def save():
                save_state(path, state)

            ecobee = EcobeeThermostat(thermostat_id, state, save)
            if args.authorize:
                ecobee.authorize()
                return 0
            return run(args, state, ecobee, save)
    except ScriptError as error:
        log_event("failed", reason=str(error))
    except (OSError, ValueError, EOFError) as error:
        log_event("failed", reason="configuration or state I/O failed", error_type=type(error).__name__)
    return 1


if __name__ == "__main__":
    sys.exit(main())
