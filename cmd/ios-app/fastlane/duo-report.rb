# snapshot generates its HTML before the separately captured Duo shots exist.
# Its report only recognizes devices in a built-in name list, so include Duo
# when regenerating the report after all three screenshot sets are complete.
module PWUsageDuoReport
  def available_devices
    { "iPhone Duo" => "iPhone Duo" }.merge(super)
  end
end
