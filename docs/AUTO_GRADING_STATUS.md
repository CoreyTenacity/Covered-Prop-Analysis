# Auto-grading and post-game notes

Status: **server grading connected for confirmed actual values; scheduled grading and grading-note storage are now in place. A provider-backed MLB box-score resolver is now wired in, while broader multi-sport box-score coverage is still pending**.

Saved picks can now retain confidence, player/game identifiers, actual value, grading time, grading status, and a plain-English grading note. The interface also distinguishes pushes and void/DNP outcomes from wins and losses.

The server now includes a protected grading job and a single daily cron entry that refreshes the board and then finalizes any persisted pick once an actual result value is available.

Activation still requires:

1. Provider adapters that return stable player IDs, game IDs, final status, and final player box scores.
2. A normalized stat map for every supported straight and combo prop.
3. A scheduled server job that grades pending picks and rechecks MLB stat corrections.
4. Supabase persistence so shared users do not depend on one browser's local storage.
5. Post-game notes derived only from confirmed box-score fields such as actual value and minutes—not AI guesses.
6. A provider-neutral grading note pipeline so the browser and server store the same result language.

Until a provider resolves a pick with confidence, the app must still show grading as manual in the browser and must not imply live results or notes will populate automatically from external stats.
The scheduled grading job can still finalize saved picks from actual values that have already been entered, and it will now attempt provider-cache resolution before leaving a pick pending-auto.
