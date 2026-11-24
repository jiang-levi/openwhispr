import { useTranslation } from "react-i18next";
import { ZOOM_SCRIBE_SINGLE_LANGUAGE_MODELS } from "../../helpers/zoomScribeProtocol.js";
import { getLanguageLabel } from "../../utils/languageSupport";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

export function ZoomScribeLanguageSelect({
  value,
  onValueChange,
  disabled,
}: {
  value: string;
  onValueChange: (model: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div onClick={(event) => event.stopPropagation()}>
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger
          aria-label={t("settings.language.transcriptionLabel")}
          className="h-7 w-32 text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(ZOOM_SCRIBE_SINGLE_LANGUAGE_MODELS).map(([modelId, locale]) => {
            const label = getLanguageLabel(locale);
            return (
              <SelectItem key={modelId} value={modelId}>
                {label === locale ? getLanguageLabel(locale.split("-")[0]) : label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}
