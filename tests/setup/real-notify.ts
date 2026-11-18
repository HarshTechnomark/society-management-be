// Opt-in (M16_REAL_NOTIFY=1): runs ANY test file with the real module 16 notification engine installed behind lib/notify, to prove modules 01 to 15 keep
// working when `registerCommunication()` is active (the swap-in of the stand-in). Without the variable the stand-in runs, as in production code paths
// that do not register module 16.
import { setNotifyEngine } from '../../src/lib/notify';
import { legacyEngine } from '../../src/modules/communication/communication.core';

setNotifyEngine(legacyEngine);
