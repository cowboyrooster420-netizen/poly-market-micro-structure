/**
 * Spread Calculation Helpers for Prediction Markets
 *
 * IMPORTANT: Prediction markets are different from traditional financial markets!
 *
 * In prediction markets:
 * - Prices represent probabilities (0 to 1, or 0% to 100%)
 * - A spread of 0.027 means 2.7 cents, which equals 2.7%, which equals 270 basis points
 * - Spreads are ABSOLUTE, not relative to the price level
 *
 * WRONG (what we fixed):
 * - spreadPercent = (spread / bestAsk) * 100  ❌
 * - spreadBps = (spread / midPrice) * 10000   ❌
 *
 * These formulas make spreads appear different at different probability levels,
 * which is incorrect. A 2.7¢ spread is always 270 bps regardless of whether
 * the market is at 10% or 90% probability.
 *
 * RIGHT (what these helpers do):
 * - spreadPercent = spread * 100              ✅
 * - spreadBps = spread * 10000                ✅
 *
 * Example:
 * Market A: Bid=1.1¢, Ask=3.8¢ (spread=2.7¢ at ~2.5% probability)
 * Market B: Bid=48.6¢, Ask=51.3¢ (spread=2.7¢ at ~50% probability)
 * Both markets have the same 270 bps spread!
 */

/**
 * Convert a decimal spread to basis points (bps)
 *
 * @param spread - The spread in decimal form (e.g., 0.027 for 2.7 cents)
 * @returns The spread in basis points (e.g., 270 for 2.7 cents)
 *
 * @example
 * toBasisPoints(0.027) // Returns 270 (2.7% = 270 bps)
 * toBasisPoints(0.01)  // Returns 100 (1% = 100 bps)
 * toBasisPoints(0.10)  // Returns 1000 (10% = 1000 bps)
 */
export function toBasisPoints(spread: number): number {
  return spread * 10000;
}

/**
 * Convert a decimal spread to percentage
 *
 * @param spread - The spread in decimal form (e.g., 0.027 for 2.7 cents)
 * @returns The spread as a percentage (e.g., 2.7 for 2.7%)
 *
 * @example
 * toPercentage(0.027) // Returns 2.7 (2.7%)
 * toPercentage(0.50)  // Returns 50 (50%)
 */
export function toPercentage(spread: number): number {
  return spread * 100;
}

/**
 * Convert basis points back to decimal spread
 *
 * @param bps - The spread in basis points (e.g., 270 for 2.7%)
 * @returns The spread in decimal form (e.g., 0.027)
 *
 * @example
 * fromBasisPoints(270)  // Returns 0.027 (2.7 cents)
 * fromBasisPoints(100)  // Returns 0.01 (1 cent)
 * fromBasisPoints(1000) // Returns 0.10 (10 cents)
 */
export function fromBasisPoints(bps: number): number {
  return bps / 10000;
}

/**
 * Convert percentage back to decimal spread
 *
 * @param percent - The spread as a percentage (e.g., 2.7 for 2.7%)
 * @returns The spread in decimal form (e.g., 0.027)
 *
 * @example
 * fromPercentage(2.7) // Returns 0.027 (2.7 cents)
 * fromPercentage(50)  // Returns 0.50 (50 cents)
 */
export function fromPercentage(percent: number): number {
  return percent / 100;
}

/**
 * Calculate spread in basis points from bid and ask prices
 *
 * This is a convenience function that calculates the spread and converts
 * it to basis points in one step.
 *
 * @param bestBid - The best bid price in decimal form
 * @param bestAsk - The best ask price in decimal form
 * @returns The spread in basis points
 *
 * @example
 * calculateSpreadBps(0.011, 0.038) // Returns 270 (2.7 cents = 270 bps)
 * calculateSpreadBps(0.50, 0.51)   // Returns 100 (1 cent = 100 bps)
 */
export function calculateSpreadBps(bestBid: number, bestAsk: number): number {
  const spread = bestAsk - bestBid;
  return toBasisPoints(spread);
}

/**
 * Calculate spread in percentage from bid and ask prices
 *
 * @param bestBid - The best bid price in decimal form
 * @param bestAsk - The best ask price in decimal form
 * @returns The spread as a percentage
 *
 * @example
 * calculateSpreadPercent(0.011, 0.038) // Returns 2.7 (2.7%)
 * calculateSpreadPercent(0.50, 0.51)   // Returns 1.0 (1%)
 */
export function calculateSpreadPercent(bestBid: number, bestAsk: number): number {
  const spread = bestAsk - bestBid;
  return toPercentage(spread);
}

/**
 * Calculate spread tightness score (0-1 scale)
 *
 * This normalizes spread against a maximum acceptable spread for prediction markets.
 * A tight spread (0 bps) returns 1.0, while spreads >= maxAcceptableBps return 0.
 *
 * @param spread - The spread in decimal form
 * @param maxAcceptableBps - Maximum acceptable spread in bps (default: 1000 = 10%)
 * @returns Tightness score from 0 to 1 (higher = tighter)
 *
 * @example
 * calculateTightness(0.01, 1000)  // 100 bps / 1000 = 0.9 tightness
 * calculateTightness(0.05, 1000)  // 500 bps / 1000 = 0.5 tightness
 * calculateTightness(0.10, 1000)  // 1000 bps / 1000 = 0.0 tightness (wide)
 */
export function calculateTightness(spread: number, maxAcceptableBps: number = 1000): number {
  const spreadBps = toBasisPoints(spread);
  const tightness = 1 - Math.min(spreadBps / maxAcceptableBps, 1);
  return Math.max(0, tightness); // Ensure non-negative
}

/**
 * Format spread for display with units
 *
 * @param spread - The spread in decimal form
 * @param format - Output format: 'bps', 'percent', or 'cents'
 * @param decimals - Number of decimal places (default: 0 for bps, 1 for percent, 2 for cents)
 * @returns Formatted string with units
 *
 * @example
 * formatSpread(0.027, 'bps')     // Returns "270 bps"
 * formatSpread(0.027, 'percent') // Returns "2.7%"
 * formatSpread(0.027, 'cents')   // Returns "2.70¢"
 */
export function formatSpread(
  spread: number,
  format: 'bps' | 'percent' | 'cents' = 'bps',
  decimals?: number
): string {
  switch (format) {
    case 'bps': {
      const bps = toBasisPoints(spread);
      const dec = decimals ?? 0;
      return `${bps.toFixed(dec)} bps`;
    }
    case 'percent': {
      const percent = toPercentage(spread);
      const dec = decimals ?? 1;
      return `${percent.toFixed(dec)}%`;
    }
    case 'cents': {
      const cents = toPercentage(spread);
      const dec = decimals ?? 2;
      return `${cents.toFixed(dec)}¢`;
    }
  }
}

/**
 * Validate that spread is reasonable for a prediction market
 *
 * @param spread - The spread to validate
 * @returns Object with validation result and message
 *
 * @example
 * validateSpread(0.027) // { valid: true, message: "Spread is within normal range" }
 * validateSpread(1.5)   // { valid: false, message: "Spread exceeds 100%" }
 * validateSpread(-0.01) // { valid: false, message: "Spread cannot be negative" }
 */
export function validateSpread(spread: number): { valid: boolean; message: string } {
  if (spread < 0) {
    return { valid: false, message: 'Spread cannot be negative' };
  }
  if (spread > 1) {
    return { valid: false, message: 'Spread exceeds 100% (prices are probabilities 0-1)' };
  }
  if (spread > 0.5) {
    return { valid: true, message: 'Warning: Spread is very wide (>50%)' };
  }
  if (spread > 0.2) {
    return { valid: true, message: 'Spread is wide but acceptable' };
  }
  return { valid: true, message: 'Spread is within normal range' };
}
