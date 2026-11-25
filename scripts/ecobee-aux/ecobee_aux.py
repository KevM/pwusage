#!/usr/bin/env python3
"""Use a PWUsage On-Peak bank to manage a fuel-fired ecobee Aux mode."""

import argparse
import fcntl
import hashlib
import json
import math
import os
import re
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from http.client import HTTPException
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

ECOBEE = "https://api.ecobee.com"
AUX = "auxHeatOnly"
HEATING_MODES = ("heat", "auto")
KNOWN_MODES = (*HEATING_MODES, AUX, "cool", "off")
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


def request_json(url, *, method="GET", token=None, etag=None, body=None):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if etag:
        headers["If-None-Match"] = etag
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = Request(url, data=None if body is None else json.dumps(body).encode(),
                      headers=headers, method=method)
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


class Ecobee:
    def __init__(self, api_key, thermostat_id, state, save):
        self.api_key = api_key
        self.thermostat_id = thermostat_id
        self.state = state
        self.save = save

    def exchange(self, **params):
        query = urlencode({"client_id": self.api_key, **params})
        status, result, _ = fetch_service("ecobee", f"{ECOBEE}/token?{query}", method="POST")
        tokens = as_object(result)
        if status != 200:
            return False
        if not all(isinstance(tokens.get(key), str) and tokens[key] for key in ("access_token", "refresh_token")):
            raise ScriptError("ecobee returned incomplete OAuth credentials.")
        expires = tokens.get("expires_in")
        if not finite_number(expires) or expires <= 0:
            raise ScriptError("ecobee returned an invalid token expiry.")
        self.state["ecobee"] = {
            "access": tokens["access_token"], "refresh": tokens["refresh_token"],
            "expires_at": time.time() + expires,
        }
        self.save()
        return True

    def authorize(self):
        query = urlencode({"response_type": "ecobeePin", "client_id": self.api_key, "scope": "smartWrite"})
        status, result, _ = fetch_service("ecobee", f"{ECOBEE}/authorize?{query}")
        if status != 200 or not isinstance(result, dict) or not result.get("ecobeePin") or not result.get("code"):
            raise ScriptError("ecobee did not issue a PIN. Check the existing API key.")
        print(f"Enter PIN {result['ecobeePin']} in ecobee's My Apps portal.")
        input("Press Enter here after registering the PIN. ")
        if not self.exchange(grant_type="ecobeePin", code=result["code"]):
            raise ScriptError("ecobee did not accept the PIN. Run --authorize to try again.")
        log_event("ecobee_authorized")

    def access_token(self, refresh=False):
        tokens = self.state.get("ecobee", {})
        if not refresh and tokens.get("access") and tokens.get("expires_at", 0) > time.time() + 60:
            return tokens["access"]
        refresh_token = tokens.get("refresh") or os.environ.get("ECOBEE_REFRESH_TOKEN")
        if not refresh_token:
            raise ScriptError("Run --authorize to connect ecobee.")
        log_event("ecobee_token_refresh_started")
        if not self.exchange(grant_type="refresh_token", refresh_token=refresh_token):
            raise ScriptError("ecobee rejected the token refresh. Run --authorize to reconnect.")
        log_event("ecobee_token_refreshed")
        return self.state["ecobee"]["access"]

    def thermostat_request(self, url, *, body=None):
        method = "GET" if body is None else "POST"
        token = self.access_token()
        for attempt in range(2):
            status, result, _ = fetch_service("ecobee", url, method=method, token=token, body=body)
            payload = as_object(result)
            code = as_object(payload.get("status")).get("code")
            if status == 200 and code == 0:
                return payload
            if attempt == 0 and (code == 14 or (status == 401 and code is None)):
                token = self.access_token(refresh=True)
                continue
            raise ScriptError(f"ecobee rejected the thermostat request (HTTP {status}, code {code if type(code) is int else 'unknown'}).")

    def read(self):
        selection = {
            "selectionType": "thermostats", "selectionMatch": self.thermostat_id,
            "includeSettings": True, "includeRuntime": True, "includeEquipmentStatus": True,
        }
        query = urlencode({"json": json.dumps({"selection": selection})})
        result = self.thermostat_request(f"{ECOBEE}/1/thermostat?{query}")
        thermostats = result.get("thermostatList")
        if not isinstance(thermostats, list):
            raise ScriptError("ecobee did not return a thermostat list.")
        matches = [item for item in thermostats
                   if isinstance(item, dict) and item.get("identifier") == self.thermostat_id]
        if len(matches) != 1:
            raise ScriptError("ecobee did not return the configured thermostat.")
        thermostat = matches[0]
        if as_object(thermostat.get("runtime")).get("connected") is not True:
            raise ScriptError("The ecobee thermostat is offline.")
        settings = as_object(thermostat.get("settings"))
        mode = settings.get("hvacMode")
        if mode not in KNOWN_MODES:
            raise ScriptError("ecobee returned an unknown HVAC mode.")
        equipment = thermostat.get("equipmentStatus")
        equipment = equipment.split(",") if isinstance(equipment, str) else []
        heating = any(item.strip() in ("heatPump", "heatPump2", "heatPump3") for item in equipment)
        return mode, settings.get("hasHeatPump") is True, heating

    def set_mode(self, mode):
        log_event("ecobee_mode_change_requested", target_mode=mode)
        self.thermostat_request(f"{ECOBEE}/1/thermostat?format=json", body={
            "selection": {"selectionType": "thermostats", "selectionMatch": self.thermostat_id},
            "thermostat": {"settings": {"hvacMode": mode}},
        })
        log_event("ecobee_mode_change_accepted", target_mode=mode)


def reconcile(ecobee, state, save, *, condition, bank, config, apply):
    previous_mode = state.get("previous_mode")
    eligible = bank is not None and bank <= config.enter_kwh
    restore = previous_mode and (bank is None or bank >= config.exit_kwh)
    if condition in ("off-peak", "scheduled restore") and apply and state.pop("manual_override", False):
        save()

    if apply and not previous_mode and (not eligible or state.get("manual_override")):
        return "no change"
    mode, has_heat_pump, heating = ecobee.read()
    log_event("ecobee_mode_observed", mode=mode, has_heat_pump=has_heat_pump, heat_pump_running=heating,
              restore_mode=previous_mode)

    if previous_mode:
        if mode != AUX:
            if apply:
                state.pop("previous_mode")
                state["manual_override"] = condition not in ("off-peak", "scheduled restore")
                save()
            return f"kept existing {mode} mode"
        if restore:
            if apply:
                ecobee.set_mode(previous_mode)
                state.pop("previous_mode")
                save()
            return f"{'requested restore to' if apply else 'would restore'} {previous_mode}"
        return "kept script-managed Aux"
    if not eligible or state.get("manual_override"):
        return f"kept existing {mode} mode"
    if not has_heat_pump or mode not in HEATING_MODES or (mode == "auto" and not heating):
        return f"kept existing {mode} mode"
    if apply:
        state["previous_mode"] = mode
        save()
        ecobee.set_mode(AUX)
    return f"{'requested' if apply else 'would request'} Aux from {mode}"


def run(args, state, ecobee, save):
    if args.authorize:
        ecobee.authorize()
        return 0
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
    commands.add_argument("--authorize", action="store_true", help="authorize the existing ecobee API key with a PIN")
    commands.add_argument("--apply", action="store_true", help="let the script set and restore HVAC mode")
    commands.add_argument("--restore", action="store_true", help="restore a script-managed mode without polling PWUsage")
    args = parser.parse_args()
    try:
        thermostat_id = required("ECOBEE_THERMOSTAT_ID")
        if not re.fullmatch(r"[0-9]+", thermostat_id):
            raise ScriptError("ECOBEE_THERMOSTAT_ID must identify one thermostat.")
        path = Path(os.environ.get("ECOBEE_AUX_STATE", "~/.local/state/pwusage-ecobee/state.json")).expanduser()
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

            ecobee = Ecobee(required("ECOBEE_API_KEY"), thermostat_id, state, save)
            return run(args, state, ecobee, save)
    except ScriptError as error:
        log_event("failed", reason=str(error))
    except (OSError, ValueError, EOFError) as error:
        log_event("failed", reason="configuration, state, or authorization I/O failed", error_type=type(error).__name__)
    return 1


if __name__ == "__main__":
    sys.exit(main())
