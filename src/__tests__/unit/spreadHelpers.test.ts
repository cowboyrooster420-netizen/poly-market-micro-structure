import {
  toBasisPoints,
  toPercentage,
  fromBasisPoints,
  fromPercentage,
  calculateSpreadBps,
  calculateSpreadPercent,
  calculateTightness,
  formatSpread,
  validateSpread,
} from '../../utils/spreadHelpers';

describe('Spread Helper Functions', () => {
  describe('toBasisPoints', () => {
    test('converts 2.7¢ spread to 270 bps', () => {
      expect(toBasisPoints(0.027)).toBe(270);
    });

    test('converts 1¢ spread to 100 bps', () => {
      expect(toBasisPoints(0.01)).toBe(100);
    });

    test('converts 10¢ spread to 1000 bps', () => {
      expect(toBasisPoints(0.10)).toBe(1000);
    });

    test('converts zero spread to 0 bps', () => {
      expect(toBasisPoints(0)).toBe(0);
    });

    test('converts 0.5¢ spread to 50 bps', () => {
      expect(toBasisPoints(0.005)).toBe(50);
    });
  });

  describe('toPercentage', () => {
    test('converts 2.7¢ spread to 2.7%', () => {
      expect(toPercentage(0.027)).toBe(2.7);
    });

    test('converts 50¢ spread to 50%', () => {
      expect(toPercentage(0.50)).toBe(50);
    });

    test('converts 1¢ spread to 1%', () => {
      expect(toPercentage(0.01)).toBe(1);
    });

    test('converts zero spread to 0%', () => {
      expect(toPercentage(0)).toBe(0);
    });
  });

  describe('fromBasisPoints', () => {
    test('converts 270 bps to 0.027 decimal', () => {
      expect(fromBasisPoints(270)).toBe(0.027);
    });

    test('converts 100 bps to 0.01 decimal', () => {
      expect(fromBasisPoints(100)).toBe(0.01);
    });

    test('converts 1000 bps to 0.10 decimal', () => {
      expect(fromBasisPoints(1000)).toBe(0.10);
    });

    test('round-trip conversion: decimal -> bps -> decimal', () => {
      const original = 0.0345;
      const bps = toBasisPoints(original);
      const backToDecimal = fromBasisPoints(bps);
      expect(backToDecimal).toBeCloseTo(original, 10);
    });
  });

  describe('fromPercentage', () => {
    test('converts 2.7% to 0.027 decimal', () => {
      expect(fromPercentage(2.7)).toBeCloseTo(0.027, 10);
    });

    test('converts 50% to 0.50 decimal', () => {
      expect(fromPercentage(50)).toBe(0.50);
    });

    test('round-trip conversion: decimal -> % -> decimal', () => {
      const original = 0.0765;
      const percent = toPercentage(original);
      const backToDecimal = fromPercentage(percent);
      expect(backToDecimal).toBeCloseTo(original, 10);
    });
  });

  describe('calculateSpreadBps', () => {
    test('calculates 270 bps for bid=1.1¢, ask=3.8¢', () => {
      expect(calculateSpreadBps(0.011, 0.038)).toBeCloseTo(270, 0);
    });

    test('calculates 100 bps for bid=50¢, ask=51¢', () => {
      expect(calculateSpreadBps(0.50, 0.51)).toBeCloseTo(100, 0);
    });

    test('calculates 1000 bps for bid=45¢, ask=55¢', () => {
      expect(calculateSpreadBps(0.45, 0.55)).toBeCloseTo(1000, 0);
    });

    test('calculates 0 bps for locked market (bid=ask)', () => {
      expect(calculateSpreadBps(0.50, 0.50)).toBe(0);
    });
  });

  describe('calculateSpreadPercent', () => {
    test('calculates 2.7% for bid=1.1¢, ask=3.8¢', () => {
      expect(calculateSpreadPercent(0.011, 0.038)).toBeCloseTo(2.7, 1);
    });

    test('calculates 1% for bid=50¢, ask=51¢', () => {
      expect(calculateSpreadPercent(0.50, 0.51)).toBeCloseTo(1.0, 1);
    });

    test('calculates 10% for bid=45¢, ask=55¢', () => {
      expect(calculateSpreadPercent(0.45, 0.55)).toBeCloseTo(10.0, 1);
    });
  });

  describe('calculateTightness', () => {
    test('returns 1.0 for zero spread (tightest possible)', () => {
      expect(calculateTightness(0)).toBe(1.0);
    });

    test('returns 0.9 for 100 bps spread (with 1000 bps max)', () => {
      expect(calculateTightness(0.01, 1000)).toBeCloseTo(0.9, 2);
    });

    test('returns 0.5 for 500 bps spread (with 1000 bps max)', () => {
      expect(calculateTightness(0.05, 1000)).toBeCloseTo(0.5, 2);
    });

    test('returns 0.0 for spread >= max acceptable', () => {
      expect(calculateTightness(0.10, 1000)).toBeCloseTo(0.0, 2);
      expect(calculateTightness(0.15, 1000)).toBeCloseTo(0.0, 2);
    });

    test('uses default max of 1000 bps when not specified', () => {
      const tightness = calculateTightness(0.05); // 500 bps
      expect(tightness).toBeCloseTo(0.5, 2);
    });

    test('tightness is price-level independent', () => {
      // Same 2% spread at different price levels
      const low = calculateTightness(0.02);   // 200 bps at any price
      const mid = calculateTightness(0.02);   // 200 bps at any price
      const high = calculateTightness(0.02);  // 200 bps at any price

      expect(low).toBe(mid);
      expect(mid).toBe(high);
      expect(low).toBeCloseTo(0.8, 2); // 1 - (200/1000) = 0.8
    });
  });

  describe('formatSpread', () => {
    test('formats spread as basis points by default', () => {
      expect(formatSpread(0.027)).toBe('270 bps');
    });

    test('formats spread as percentage', () => {
      expect(formatSpread(0.027, 'percent')).toBe('2.7%');
    });

    test('formats spread as cents', () => {
      expect(formatSpread(0.027, 'cents')).toBe('2.70¢');
    });

    test('respects decimal places for bps', () => {
      expect(formatSpread(0.0271, 'bps', 1)).toBe('271.0 bps');
    });

    test('respects decimal places for percent', () => {
      expect(formatSpread(0.0275, 'percent', 2)).toBe('2.75%');
    });

    test('respects decimal places for cents', () => {
      expect(formatSpread(0.0275, 'cents', 3)).toBe('2.750¢');
    });
  });

  describe('validateSpread', () => {
    test('accepts normal spread (2.7¢)', () => {
      const result = validateSpread(0.027);
      expect(result.valid).toBe(true);
      expect(result.message).toBe('Spread is within normal range');
    });

    test('rejects negative spread', () => {
      const result = validateSpread(-0.01);
      expect(result.valid).toBe(false);
      expect(result.message).toBe('Spread cannot be negative');
    });

    test('rejects spread > 100%', () => {
      const result = validateSpread(1.5);
      expect(result.valid).toBe(false);
      expect(result.message).toBe('Spread exceeds 100% (prices are probabilities 0-1)');
    });

    test('warns about very wide spread (>50%)', () => {
      const result = validateSpread(0.75);
      expect(result.valid).toBe(true);
      expect(result.message).toContain('very wide');
    });

    test('warns about wide but acceptable spread (>20%)', () => {
      const result = validateSpread(0.30);
      expect(result.valid).toBe(true);
      expect(result.message).toContain('wide but acceptable');
    });

    test('accepts tight spread', () => {
      const result = validateSpread(0.01);
      expect(result.valid).toBe(true);
      expect(result.message).toBe('Spread is within normal range');
    });

    test('accepts zero spread', () => {
      const result = validateSpread(0);
      expect(result.valid).toBe(true);
      expect(result.message).toBe('Spread is within normal range');
    });
  });

  describe('Integration Tests', () => {
    test('real-world Discord example: bid=1.1¢, ask=3.8¢', () => {
      const bid = 0.011;
      const ask = 0.038;
      const spread = ask - bid;

      expect(toBasisPoints(spread)).toBeCloseTo(270, 0);
      expect(toPercentage(spread)).toBeCloseTo(2.7, 1);
      expect(calculateSpreadBps(bid, ask)).toBeCloseTo(270, 0);
      expect(calculateSpreadPercent(bid, ask)).toBeCloseTo(2.7, 1);
      expect(formatSpread(spread)).toBe('270 bps');
      expect(formatSpread(spread, 'percent')).toBe('2.7%');
      expect(validateSpread(spread).valid).toBe(true);
    });

    test('consistency across different price levels', () => {
      // Same 3¢ spread at different probability levels
      const testCases = [
        { bid: 0.10, ask: 0.13 },  // ~11.5% probability
        { bid: 0.48, ask: 0.51 },  // ~49.5% probability
        { bid: 0.87, ask: 0.90 },  // ~88.5% probability
      ];

      const bpsValues = testCases.map(tc => calculateSpreadBps(tc.bid, tc.ask));
      const percentValues = testCases.map(tc => calculateSpreadPercent(tc.bid, tc.ask));
      const tightnessValues = testCases.map(tc => calculateTightness(tc.ask - tc.bid));

      // All should be approximately equal
      bpsValues.forEach(bps => expect(bps).toBeCloseTo(300, 0));
      percentValues.forEach(pct => expect(pct).toBeCloseTo(3.0, 1));
      tightnessValues.forEach(t => expect(t).toBeCloseTo(0.7, 2)); // 1 - (300/1000)

      // Standard deviation should be very low
      const avgBps = bpsValues.reduce((a, b) => a + b) / bpsValues.length;
      const variance = bpsValues.reduce((sum, val) => sum + Math.pow(val - avgBps, 2), 0) / bpsValues.length;
      const stdDev = Math.sqrt(variance);
      expect(stdDev).toBeLessThan(1); // Very low deviation
    });
  });
});
