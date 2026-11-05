import { createMembersHandler } from './members-session-app.mjs';

// The comments routes live in Ghost's members app; the function is separate for
// its own sizing, concurrency and route set.
export const handler = await createMembersHandler();
