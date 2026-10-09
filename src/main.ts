// The page's entry point: loads the layout and the offered styles, then
// wires the controls to the generators. The theme and style attributes are
// already on <html>: the render-blocking boot script (src/boot/theme.ts) set
// them before the first paint, from the saved settings when there are any.
// A password and a passphrase are generated at once, with no click (R5).

import "./styles.css";
import "virtual:passgen-styles";
import { config } from "./config/validate.ts";
import { mountFocusVisibility } from "./ui/focus.ts";
import { createMeter } from "./ui/meter.ts";
import { mountPassphrasePanel } from "./ui/passphrase.ts";
import { mountPasswordPanel } from "./ui/password.ts";
import { startPointerEffect } from "./ui/pointer.ts";
import { createResultsBox } from "./ui/results.ts";
import { browserStorage, createSettingsStore, initialSettings, mountSaveControl } from "./ui/settings.ts";
import { mountThemeControls } from "./ui/theme.ts";

// Saved settings (R24 to R26): the store starts from the valid stored settings,
// else the configured defaults. Nothing is written unless Save or Reset is
// pressed; Reset puts the defaults in the store and the panels show them.
const storage = browserStorage();
const store = createSettingsStore(initialSettings(config, storage).settings);
mountFocusVisibility();
const pointer = startPointerEffect();
const theme = mountThemeControls(store, () => pointer.refresh());
const password = mountPasswordPanel(store, config, { meter: createMeter("pw"), results: createResultsBox("pw") });
const passphrase = mountPassphrasePanel(store, config, { meter: createMeter("pp"), results: createResultsBox("pp") });
mountSaveControl(store, config, storage, () => {
  theme.refresh();
  password.refresh();
  passphrase.refresh();
});

// The end-to-end tests wait for this to prove that same-origin script runs under the CSP.
document.documentElement.dataset.ready = "true";
