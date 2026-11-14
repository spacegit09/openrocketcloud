// A feature page (features/*.html): public, with sign-in buttons that turn into a link to the app
// for someone already signed in.
import { currentUser } from './base44.js';
import { markSignedIn, setupTour } from './tour.js';

setupTour();
currentUser().then((me) => me && markSignedIn()).catch(() => {});
