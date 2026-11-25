import argparse
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timezone
from io import StringIO
from pathlib import Path
from unittest.mock import Mock, patch

import ecobee_aux as aux

CONFIG = aux.BillingConfig("https://pwusage.example/api/integrations/v1/billing",
                           "test-token", "on peak", 1, 3, 60)
NOW = datetime(2026, 11, 24, 20, tzinfo=timezone.utc)


def bill(*, active="ON_PEAK", bank=0.5, through="2026-11-24T19:55:00Z"):
    return {
        "currentBill": {"status": "complete"},
        "sources": {"energyDataThrough": through},
        "loadTiming": {
            "hasCycleData": True,
            "pricingPeriods": [
                {"name": "ON_PEAK", "isActive": active == "ON_PEAK", "cycleNetExportKwh": bank},
                {"name": "OFF_PEAK", "isActive": active == "OFF_PEAK", "cycleNetExportKwh": 20},
            ],
        },
    }


class BillingTests(unittest.TestCase):
    def test_reads_signed_bank_for_active_peak_only(self):
        self.assertEqual(aux.read_bank(bill(bank=-2), CONFIG, NOW), aux.BankReading("on-peak", -2, "ON_PEAK", 300))
        self.assertEqual(aux.read_bank(bill(active="OFF_PEAK"), CONFIG, NOW).condition, "off-peak")

    def test_refuses_stale_missing_or_incomplete_data(self):
        stale = bill(through="2026-11-24T18:55:00Z")
        incomplete = bill()
        incomplete["currentBill"]["status"] = "incomplete-attribution"
        for payload in (stale, incomplete, {"loadTiming": []}, bill(bank=True)):
            with self.subTest(payload=payload):
                self.assertIsNone(aux.read_bank(payload, CONFIG, NOW).bank_kwh)

    @patch.object(aux, "fetch_service")
    def test_conditional_poll_does_not_make_the_cached_sample_newer(self, fetch):
        state = {}
        fetch.side_effect = [(200, bill(), '"v1"'), (304, None, '"v1"')]
        first, first_status = aux.fetch_bill(CONFIG, state, Mock())
        second, second_status = aux.fetch_bill(CONFIG, state, Mock())
        self.assertEqual(first, second)
        self.assertEqual((first_status, second_status), (200, 304))
        self.assertEqual(fetch.call_args.kwargs["etag"], '"v1"')
        later = datetime(2026, 11, 24, 21, tzinfo=timezone.utc)
        self.assertIsNone(aux.read_bank(second, CONFIG, later).bank_kwh)


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.ecobee = Mock()
        self.ecobee.read.return_value = ("heat", True, False)
        self.state = {}
        self.save = Mock()

    def reconcile(self, bank, *, apply=True, condition="on-peak"):
        return aux.reconcile(self.ecobee, self.state, self.save, condition=condition,
                             bank=bank, config=CONFIG, apply=apply)

    def test_dry_run_reports_action_without_claiming_or_writing(self):
        self.assertEqual(self.reconcile(1, apply=False), "would request Aux from heat")
        self.assertEqual(self.state, {})
        self.ecobee.set_mode.assert_not_called()

    def test_saves_previous_mode_before_command_and_restores_at_upper_threshold(self):
        def check_saved(mode):
            if mode == aux.AUX:
                self.assertEqual(self.state["previous_mode"], "heat")
                self.save.assert_called_once()

        self.ecobee.set_mode.side_effect = check_saved
        self.reconcile(1)
        self.ecobee.read.return_value = (aux.AUX, True, False)
        self.reconcile(2)
        self.ecobee.set_mode.assert_called_once_with(aux.AUX)

        self.reconcile(3)
        self.ecobee.set_mode.assert_called_with("heat")
        self.assertEqual(self.state["previous_mode"], "heat")
        self.assertTrue(self.state["restore_pending"])
        self.reconcile(0)
        self.ecobee.set_mode.assert_called_with("heat")
        self.ecobee.read.return_value = ("heat", True, False)
        self.assertEqual(self.reconcile(3), "confirmed restore to heat")
        self.assertNotIn("previous_mode", self.state)
        self.assertNotIn("restore_pending", self.state)

    def test_failed_restore_leaves_previous_mode_for_next_cron_run(self):
        self.state["previous_mode"] = "auto"
        self.ecobee.read.return_value = (aux.AUX, True, False)
        self.ecobee.set_mode.side_effect = [aux.ScriptError("ecobee unavailable"), None]
        args = argparse.Namespace(apply=False, restore=True)
        with patch.object(aux, "fetch_bill") as poll:
            with self.assertRaises(aux.ScriptError):
                aux.run(args, self.state, self.ecobee, self.save)
            self.assertEqual(self.state["previous_mode"], "auto")
            self.assertEqual(aux.run(args, self.state, self.ecobee, self.save), 0)
            self.assertEqual(self.state["previous_mode"], "auto")
            self.ecobee.read.return_value = ("auto", True, False)
            self.assertEqual(aux.run(args, self.state, self.ecobee, self.save), 0)
            poll.assert_not_called()
        self.ecobee.set_mode.assert_called_with("auto")
        self.assertNotIn("previous_mode", self.state)

    def test_off_peak_cron_with_no_override_exits_without_network_calls(self):
        args = argparse.Namespace(apply=False, restore=True)
        with patch.object(aux, "fetch_bill") as poll:
            self.assertEqual(aux.run(args, self.state, self.ecobee, self.save), 0)
            poll.assert_not_called()
        self.ecobee.read.assert_not_called()

    def test_restores_on_a_failed_pwusage_poll(self):
        self.state["previous_mode"] = "heat"
        self.ecobee.read.return_value = (aux.AUX, True, False)
        args = argparse.Namespace(apply=True, restore=False)
        with patch.object(aux.BillingConfig, "load", return_value=CONFIG):
            with patch.object(aux, "fetch_bill", side_effect=aux.ScriptError("PWUsage unavailable")):
                self.assertEqual(aux.run(args, self.state, self.ecobee, self.save), 1)
        self.ecobee.set_mode.assert_called_once_with("heat")

    def test_keeps_manual_changes_until_off_peak(self):
        self.state["previous_mode"] = "heat"
        self.reconcile(0)
        self.assertTrue(self.state["manual_override"])
        self.reconcile(0)
        self.ecobee.set_mode.assert_not_called()
        self.reconcile(None, condition="off-peak")
        self.assertNotIn("manual_override", self.state)
        self.reconcile(0)
        self.ecobee.set_mode.assert_called_once_with(aux.AUX)

    def test_delayed_aux_keeps_restore_state_across_the_boundary(self):
        self.ecobee.set_mode.side_effect = aux.ScriptError("Aux unconfirmed")
        with self.assertRaises(aux.ScriptError):
            self.reconcile(0)
        self.assertEqual(self.reconcile(None, condition="off-peak"), "awaiting Aux confirmation")
        self.assertEqual(self.state["previous_mode"], "heat")
        self.ecobee.read.return_value = (aux.AUX, True, False)
        self.ecobee.set_mode.side_effect = None
        self.reconcile(None, condition="off-peak")
        self.ecobee.set_mode.assert_called_with("heat")
        self.assertTrue(self.state["restore_pending"])

    def test_leaves_manual_aux_cooling_and_auto_without_heat_demand_alone(self):
        for mode in (aux.AUX, "cool", "off", "auto"):
            with self.subTest(mode=mode):
                self.ecobee.read.return_value = (mode, True, False)
                self.reconcile(0)
        self.ecobee.set_mode.assert_not_called()


    def test_logs_cached_sample_age_thresholds_and_action_without_secrets(self):
        args = argparse.Namespace(apply=False, restore=False)
        output = StringIO()
        with redirect_stdout(output), patch.object(aux.BillingConfig, "load", return_value=CONFIG):
            with patch.object(aux, "fetch_bill", return_value=(bill(), 304)):
                with patch.object(aux, "datetime", wraps=datetime) as clock:
                    clock.now.return_value = NOW
                    self.assertEqual(aux.run(args, self.state, self.ecobee, self.save), 0)
        evaluation, observed, completed = map(json.loads, output.getvalue().splitlines())
        self.assertEqual(evaluation["billing_http_status"], 304)
        self.assertEqual(evaluation["sample_age_seconds"], 300)
        self.assertEqual(evaluation["active_period"], "ON_PEAK")
        self.assertEqual((evaluation["enter_kwh"], evaluation["exit_kwh"]), (1, 3))
        self.assertEqual(evaluation["bank_kwh"], 0.5)
        self.assertEqual(observed["mode"], "heat")
        self.assertEqual(completed["action"], "would request Aux from heat")
        self.assertEqual(evaluation["run_id"], completed["run_id"])
        self.assertNotIn(CONFIG.token, output.getvalue())


class EcobeeApiTests(unittest.TestCase):
    def setUp(self):
        self.state = {"ecobee_tokens": {aux.ECOBEE_REFRESH_TOKEN: "test-refresh"}}
        self.save = Mock()
        self.thermostat = aux.EcobeeThermostat("123", self.state, self.save)

    @staticmethod
    def thermostat_response(mode):
        response = Mock(status_code=200)
        response.json.return_value = {
            "status": {"code": 0},
            "thermostatList": [
                {"identifier": "456", "settings": {"hvacMode": "cool"}},
                {"identifier": "123", "runtime": {"connected": True},
                 "settings": {"hvacMode": mode, "hasHeatPump": True},
                 "equipmentStatus": "fan,heatPump"},
            ],
        }
        return response

    @patch("pyecobee.requests.request")
    @patch("pyecobee.requests.post")
    def test_refreshes_and_confirms_aux_and_restore_for_the_selected_thermostat(self, refresh, request):
        refresh.return_value.json.return_value = {"access_token": "new-access", "refresh_token": "rotated-refresh"}
        accepted = Mock(status_code=200)
        accepted.json.return_value = {"status": {"code": 0}}
        request.side_effect = [
            self.thermostat_response("auto"), accepted, self.thermostat_response(aux.AUX),
            accepted, self.thermostat_response("auto"),
        ]
        self.assertEqual(self.thermostat.read(), ("auto", True, True))
        self.thermostat.set_mode(aux.AUX)
        self.thermostat.set_mode("auto")
        self.assertEqual(self.state["ecobee_tokens"], {
            aux.ECOBEE_ACCESS_TOKEN: "new-access", aux.ECOBEE_REFRESH_TOKEN: "rotated-refresh",
        })
        self.save.assert_called_once()
        refresh.assert_called_once()
        for call, mode in ((request.call_args_list[1], aux.AUX), (request.call_args_list[3], "auto")):
            self.assertEqual(call.args[0], "POST")
            self.assertEqual(call.kwargs["json"], {
                "selection": {"selectionType": "thermostats", "selectionMatch": "123"},
                "thermostat": {"settings": {"hvacMode": mode}},
            })

    def test_authorizes_with_mfa_and_saves_only_tokens(self):
        login = Mock(access_token="test-access", refresh_token="test-refresh")
        login.refresh_tokens.side_effect = aux.EcobeeAuthMfaRequiredError("test-challenge")
        login.submit_mfa_code.return_value = True
        with patch.object(aux.sys.stdin, "isatty", return_value=True):
            with patch("builtins.input", return_value="test@example.com"):
                with patch.object(aux, "getpass", side_effect=["test-password", "test-otp"]):
                    with patch.object(aux, "Ecobee", side_effect=[login, login]) as library:
                        with patch.object(self.thermostat, "read", return_value=("heat", True, False)):
                            self.thermostat.authorize()
        login.submit_mfa_code.assert_called_once_with("test-challenge", "test-otp")
        self.assertEqual(library.call_args.kwargs["config"], {
            aux.ECOBEE_ACCESS_TOKEN: "test-access", aux.ECOBEE_REFRESH_TOKEN: "test-refresh",
        })
        self.assertNotIn("test-password", json.dumps(self.state))
        self.assertNotIn("test-otp", json.dumps(self.state))

    def test_unconfirmed_mode_does_not_log_success(self):
        output = StringIO()
        with redirect_stdout(output), patch.object(self.thermostat, "thermostat_index", return_value=0):
            with patch.object(self.thermostat, "call"), patch.object(self.thermostat, "read", return_value=("heat", True, False)):
                with self.assertRaisesRegex(aux.ScriptError, "not reported"):
                    self.thermostat.set_mode(aux.AUX)
        requested, unconfirmed = map(json.loads, output.getvalue().splitlines())
        self.assertEqual(requested["event"], "ecobee_mode_change_requested")
        self.assertEqual(unconfirmed["event"], "ecobee_mode_change_unconfirmed")
        self.assertEqual(unconfirmed["observed_mode"], "heat")
        self.assertNotIn("test-refresh", output.getvalue())

    def test_private_state_persists_across_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "state.json")
            state = {"thermostat_id": "123", "previous_mode": "heat"}
            aux.save_state(path, state)
            self.assertEqual(aux.load_state(path, "123"), state)
            self.assertEqual(json.loads(path.read_text()), state)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(aux.ScriptError):
                aux.load_state(path, "456")


if __name__ == "__main__":
    unittest.main()
