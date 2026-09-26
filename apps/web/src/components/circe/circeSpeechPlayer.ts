/**
 * One voice for Circe on this device: replies and notices play one at a time,
 * and the user talking again cuts whatever is playing or queued.
 */

let current: HTMLAudioElement | null = null;
let queue: Promise<void> = Promise.resolve();
let generation = 0;

/** Plays base64 MP3 after anything already queued; resolves when it ends or is cut. */
export function playCirceSpeech(audio: string): Promise<void> {
  const queuedIn = generation;
  const play = () =>
    queuedIn !== generation
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const element = new Audio(`data:audio/mpeg;base64,${audio}`);
          current = element;
          const done = () => {
            if (current === element) current = null;
            resolve();
          };
          element.addEventListener("ended", done, { once: true });
          element.addEventListener("error", done, { once: true });
          element.addEventListener("pause", done, { once: true });
          element.play().catch(done);
        });
  queue = queue.then(play, play);
  return queue;
}

/** Stops what Circe is saying and drops anything queued behind it. */
export function stopCirceSpeech(): void {
  generation += 1;
  current?.pause();
  current = null;
}
