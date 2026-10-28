/** Work that grows with its size takes about 4 times as long at four times the size, and 16 where each part is held against every other. */
export const LINEAR = 8;

/** How many times longer `measure` takes at four times `size`; each size keeps its fastest of `rounds` in turn, so a pause or a cold first run decides nothing. */
export async function growth(size: number, measure: (size: number) => number | Promise<number>, rounds = 5): Promise<number> {
  const small: number[] = [];
  const large: number[] = [];
  for (let round = 0; round < rounds; round++) {
    small.push(await measure(size));
    large.push(await measure(size * 4));
  }

  return Math.min(...large) / Math.min(...small);
}
