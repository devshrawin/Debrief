// Tour enhancer: orbs and a beam while a key or connection test runs. The tour's own script still owns every step.
import { orbifySpinners, watchStatuses, ready } from '../common.js';

ready(() => {
  orbifySpinners();
  watchStatuses(document.getElementById('stage'), '.status');
});
