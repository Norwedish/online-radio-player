/**
 * One app-wide audio output at a time: the processed listener stream and the
 * direct studio monitor would otherwise play on top of each other (with a
 * few seconds' offset). Starting one stops the other.
 */
let owner: { name: string; stop: () => void } | null = null;

export function claimAudio(name: string, stop: () => void): void {
  const prev = owner;
  owner = null;
  if (prev && prev.name !== name) prev.stop();
  owner = { name, stop };
}

export function releaseAudio(name: string): void {
  if (owner?.name === name) owner = null;
}
