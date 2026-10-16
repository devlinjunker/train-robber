// Frame ids for placements: the world, or one car of a train.
export const WORLD_FRAME = 'world';
export const carFrame = (trainId: string, car: number) => `car:${trainId}:${car}`;

/** The train and car index of a car frame, or null for the world frame. */
export function parseCarFrame(frame: string): { trainId: string; car: number } | null {
  if (!frame.startsWith('car:')) return null;
  const i = frame.lastIndexOf(':');
  return { trainId: frame.slice(4, i), car: Number(frame.slice(i + 1)) };
}

