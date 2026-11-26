// A version as the providers' CLIs and the npm registry write them: three numbers, and perhaps a
// pre-release after a hyphen and build metadata after a plus.
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function isVersion(text: string): boolean {
  return VERSION.test(text);
}

// Compares two versions as semantic versioning orders them: by their numbers, then a pre-release
// before the release, and pre-releases by their parts, numbers below words; build metadata counts for
// nothing. Negative where a comes first, positive where b does, zero where they are equal.
export function compareVersions(a: string, b: string): number {
  const left = VERSION.exec(a);
  const right = VERSION.exec(b);
  if (left === null || right === null) throw new Error(`Not a version: ${left === null ? a : b}`);
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) return Math.sign(difference);
  }
  const [preA, preB] = [left[4], right[4]];
  if (preA === undefined || preB === undefined) {
    return preA === preB ? 0 : preA === undefined ? 1 : -1;
  }
  const partsA = preA.split('.');
  const partsB = preB.split('.');
  for (let index = 0; index < Math.max(partsA.length, partsB.length); index += 1) {
    const [partA, partB] = [partsA[index], partsB[index]];
    if (partA === undefined || partB === undefined) return partA === undefined ? -1 : 1;
    if (partA === partB) continue;
    const [numberA, numberB] = [/^\d+$/.test(partA), /^\d+$/.test(partB)];
    if (numberA && numberB) return Math.sign(Number(partA) - Number(partB));
    if (numberA !== numberB) return numberA ? -1 : 1;
    return partA < partB ? -1 : 1;
  }
  return 0;
}
