import type { Preset } from './define';
import { DOCKER_PRESETS } from './docker';
import { FILE_PRESETS } from './files';
import { GIT_PRESETS } from './git';
import { LINUX_PRESETS } from './linux';
import { NETWORK_PRESETS } from './network';
import { POWERSHELL_PRESETS } from './powershell';
import { SSH_PRESETS } from './ssh';
import { TROUBLESHOOTING_PRESETS } from './troubleshooting';

export type { Preset } from './define';

export interface PresetLibrary {
  /** Raised with every change to the library, so that an upgrade knows there is something to import. */
  version: number;
  presets: readonly Preset[];
}

export const PRESET_LIBRARY: PresetLibrary = {
  version: 1,
  presets: [
    ...LINUX_PRESETS,
    ...NETWORK_PRESETS,
    ...SSH_PRESETS,
    ...DOCKER_PRESETS,
    ...GIT_PRESETS,
    ...TROUBLESHOOTING_PRESETS,
    ...FILE_PRESETS,
    ...POWERSHELL_PRESETS
  ]
};
