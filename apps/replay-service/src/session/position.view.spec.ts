import { pointsToDecimal } from './position.view';

describe('points -> exact price text', () => {
  it.each([
    [113030, 5, '1.13030'], [1812805, 3, '1812.805'], [114929, 3, '114.929'], [7, 5, '0.00007'], [-14, 5, '-0.00014'],
  ])('%p at %p decimals -> %p', (points, decimals, text) => {
    expect(pointsToDecimal(points, decimals)).toBe(text);
  });
});
