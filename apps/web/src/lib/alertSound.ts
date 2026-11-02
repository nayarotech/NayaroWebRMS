/**
 * The service alarm for the till.
 *
 * A DELIBERATE TWIN of apps/web/src/lib/alertSound.ts, not an import. The two
 * apps are separate surfaces with separate builds and no shared browser code -
 * `@nayaro/shared` is imported by the Node server, so Web Audio cannot live
 * there. What must not drift is the SOUND itself, so if the tone changes here
 * it changes there: a restaurant hearing two different chimes from the till
 * and the kitchen would learn to read them as two different things.
 *
 * The till alarms on a DIFFERENT event from the kitchen's, though. The kitchen
 * is told when a ticket arrives ("cook this"); the counter is told when one is
 * ready ("go and serve it"). Each alarm is actionable by whoever hears it,
 * which is the only way an alarm survives a month of service without being
 * turned off.
 *
 * SYNTHESISED, not a file. A restaurant machine is frequently offline and the
 * renderer's Content-Security-Policy allows no remote media, so an audio asset
 * is one more thing to bundle and have fail silently. The Web Audio API makes
 * the tone on the device, which is always available and costs nothing to load.
 *
 * DESIGNED TO BE HEARD OVER A KITCHEN, which is a specific and unusual brief:
 *
 *  - a two-tone chime repeated several times, not a single beep. Extractor
 *    fans, a wok burner and a radio will eat any one sound; a pattern that
 *    repeats for a couple of seconds gets through.
 *  - built around 880-1320Hz. Kitchen noise is broadband but weighted low, and
 *    this band sits above the worst of it while staying inside what a cheap
 *    tablet speaker can actually reproduce. A 200Hz tone would be inaudible
 *    and a 5kHz one would be shrill and lost.
 *  - a square-ish wave with a hard attack. A soft sine is pleasant and does
 *    not cut through; the harmonics are what makes it carry.
 *  - full gain. There is a volume knob on the tablet, and a kitchen alarm that
 *    politely plays at 30% is a kitchen alarm nobody hears.
 *
 * BROWSERS BLOCK AUDIO until the user has interacted with the page, and a
 * kitchen tablet left on a wall is exactly the case where that bites: the
 * board reloads after a power cut and every ticket then arrives in silence.
 * `unlock()` is called from the sign-in tap - a real gesture - and `isReady()`
 * lets the board say so when it is not.
 */

let context: AudioContext | null = null;

type AudioContextCtor = new () => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * Creates or resumes the audio context. MUST be called from inside a user
 * gesture the first time, or the browser starts it suspended and every later
 * sound is silently dropped.
 */
export function unlockAlertSound(): void {
  const Ctor = audioContextCtor();
  if (Ctor === null) return;

  context ??= new Ctor();
  if (context.state === 'suspended') {
    void context.resume().catch(() => {
      /* Nothing useful to do; isReady() will report it. */
    });
  }
}

/** Whether a sound would actually play right now. Drives the board's warning. */
export function isAlertSoundReady(): boolean {
  return context !== null && context.state === 'running';
}

/** One two-tone chime, starting at `at` on the context clock. */
function chime(ctx: AudioContext, at: number): void {
  // Rising interval - the "ta-da" shape a person reads as "look at me" rather
  // than the falling one that reads as an error.
  for (const [index, frequency] of [880, 1320].entries()) {
    const start = at + index * 0.13;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    // Square carries; its odd harmonics are what survive a noisy room.
    oscillator.type = 'square';
    oscillator.frequency.setValueAtTime(frequency, start);

    /*
     * A hard attack and a short decay. Ramps rather than instant jumps at both
     * ends: switching a gain node discontinuously produces an audible click
     * on most hardware, which on a cheap speaker sounds like a fault.
     */
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.9, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.12);

    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.14);
  }
}

/**
 * Sounds the alarm.
 *
 * `repeats` is the number of chimes; four takes about a second and a half,
 * which is long enough to be noticed across a kitchen and short enough not to
 * become the thing everyone wants switched off.
 */
export function playNewTicketAlert(repeats = 4): void {
  unlockAlertSound();
  const ctx = context;
  if (ctx === null || ctx.state !== 'running') return;

  // Scheduled on the audio clock rather than with setTimeout: timers drift and
  // stall under load, and a chime pattern with uneven gaps sounds broken.
  const now = ctx.currentTime;
  for (let index = 0; index < repeats; index += 1) {
    chime(ctx, now + index * 0.38);
  }
}

/** A single, quieter chime. For a status change rather than new work. */
export function playSoftAlert(): void {
  unlockAlertSound();
  const ctx = context;
  if (ctx === null || ctx.state !== 'running') return;
  chime(ctx, ctx.currentTime);
}
