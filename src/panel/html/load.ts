// The HTML door (html/door.ts), loaded the first time a file has HTML to draw through it.

import { onDemand } from '../onDemand';

export const door = onDemand(() => import('./door'));
