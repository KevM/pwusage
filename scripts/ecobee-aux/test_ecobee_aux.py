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


class HomeAssistantApiTests(unittest.TestCase):
    def setUp(self):
        env = {
            "HA_URL": "http://127.0.0.1:8123", "HA_TOKEN": "test-ha-token",
            "HA_CLIMATE_ENTITY": "climate.ecobee", "HA_AUX_SWITCH": "switch.ecobee_aux",
        }
        with patch.dict("os.environ", env, clear=True):
            self.thermostat = aux.HomeAssistant()

    @patch.object(aux, "fetch_service")
    def test_requires_both_entities_and_distinguishes_aux_from_normal_heat(self, fetch):
        climate = {"entity_id": "climate.ecobee", "state": "heat",
                   "attributes": {"equipment_running": "fan,heatPump"}}
        fetch.side_effect = [
            (200, {"entity_id": "switch.ecobee_aux", "state": "on"}, None),
            (200, climate, None),
            (200, {"entity_id": "switch.ecobee_aux", "state": "off"}, None),
            (200, {**climate, "state": "heat_cool"}, None),
            (200, {"entity_id": "switch.ecobee_aux", "state": "unavailable"}, None),
        ]
        self.assertEqual(self.thermostat.read(), (aux.AUX, True, True))
        self.assertEqual(self.thermostat.read(), ("auto", True, True))
        with self.assertRaisesRegex(aux.ScriptError, "could not read"):
            self.thermostat.read()
        self.assertEqual(fetch.call_args_list[0].args[1], "http://127.0.0.1:8123/api/states/switch.ecobee_aux")
        self.assertEqual(fetch.call_args_list[1].args[1], "http://127.0.0.1:8123/api/states/climate.ecobee")

    @patch.object(aux, "fetch_service")
    def test_enables_aux_and_restores_the_saved_mode_explicitly(self, fetch):
        fetch.return_value = (200, [], None)
        self.thermostat.set_mode(aux.AUX)
        self.thermostat.set_mode("auto")
        request_aux, request_restore = fetch.call_args_list
        self.assertEqual(request_aux.args[1], "http://127.0.0.1:8123/api/services/switch/turn_on")
        self.assertEqual(request_aux.kwargs, {
            "token": "test-ha-token", "method": "POST", "body": {"entity_id": "switch.ecobee_aux"},
        })
        self.assertEqual(request_restore.args[1], "http://127.0.0.1:8123/api/services/climate/set_hvac_mode")
        self.assertEqual(request_restore.kwargs["body"], {"entity_id": "climate.ecobee", "hvac_mode": "heat_cool"})

    def test_failed_home_assistant_command_logs_the_attempt_without_claiming_success(self):
        output = StringIO()
        with redirect_stdout(output), patch.object(aux, "fetch_service", return_value=(503, None, None)):
            with self.assertRaisesRegex(aux.ScriptError, "HTTP 503"):
                self.thermostat.set_mode("heat")
        [event] = list(map(json.loads, output.getvalue().splitlines()))
        self.assertEqual(event["event"], "ecobee_mode_change_requested")
        self.assertEqual(event["target_mode"], "heat")
        self.assertNotIn("test-ha-token", output.getvalue())

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
