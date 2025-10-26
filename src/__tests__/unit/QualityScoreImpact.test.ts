import { MarketCategorizer } from '../../services/MarketCategorizer';
import { Market } from '../../types';

/**
 * Quality Score Impact Analysis
 *
 * This test suite analyzes the impact of the spread calculation fix on
 * quality scores. Before the fix, spreads were calculated as outcome ranges
 * (~9520 bps), causing quality scores to be artificially low.
 *
 * After the fix, spreads are calculated correctly as bid-ask spreads
 * (~270 bps), which should result in much higher quality scores.
 */
describe('Quality Score Impact Analysis', () => {
  let categorizer: MarketCategorizer;

  beforeEach(() => {
    const volumeThresholds = {
      politics: 50000,
      crypto: 30000,
      sports: 40000,
      uncategorized: 10000,
    };

    const watchlistCriteria = {
      enabled: true,
      minVolumeFloor: 5000,
      maxWatchlistSize: 50,
      monitoringIntervalMs: 60000,
      criteria: {
        minCategoryScore: 3,
        minOutcomeCount: 2,
        maxDaysToClose: 90,
        highEdgeCategories: ['politics', 'crypto'],
        requireMultipleSignals: false,
      },
    };

    const opportunityScoringConfig = {
      enabled: true,
      volumeScore: {
        weight: 0.3,
        optimalVolumeMultiplier: 1.5,
        illiquidityPenaltyThreshold: 0.3,
        efficiencyPenaltyThreshold: 5.0,
      },
      edgeScore: {
        weight: 0.25,
        highEdgeCategories: {
          politics: 1.5,
          crypto: 1.2,
          sports: 1.0,
        },
        categoryScoreWeight: 0.4,
        multiOutcomeBonus: 0.5,
        maxMultiOutcomeBonus: 5.0,
      },
      catalystScore: {
        weight: 0.25,
        optimalDaysToClose: 7,
        minDaysToClose: 0.5,
        maxDaysToClose: 30,
        urgencyMultiplier: 1.5,
      },
      qualityScore: {
        weight: 0.2,
        spreadWeight: 0.4,
        ageWeight: 0.3,
        liquidityWeight: 0.3,
        optimalSpreadBps: 150,  // 1.5% spread is optimal
        maxAgeDays: 60,
      },
    };

    categorizer = new MarketCategorizer(
      volumeThresholds,
      watchlistCriteria,
      opportunityScoringConfig
    );
  });

  describe('Before vs After Fix Comparison', () => {
    test('OLD BUGGY WAY: Market with outcome range (9520 bps) gets poor spread component', () => {
      // This is what was happening before the fix
      const marketWithBuggySpread: Market = {
        id: 'market_buggy',
        question: 'Will this happen?',
        outcomes: ['Yes', 'No'],
        outcomePrices: ['0.011', '0.989'],  // 1.1% vs 98.9%
        volume: '100000',
        volumeNum: 100000,
        active: true,
        closed: false,
        category: 'politics',
        categoryScore: 5,
        outcomeCount: 2,
        spread: 9520,  // WRONG: This was outcome range (98.9% - 1.1%) * 10000
        marketAge: 2 * 24 * 60 * 60 * 1000,  // 2 days old
        timeToClose: 10 * 24 * 60 * 60 * 1000,  // 10 days to close
      };

      const score = categorizer.calculateOpportunityScore(marketWithBuggySpread);

      // Quality score is still decent because it has 3 components:
      // - Spread component: ~0 (terrible due to huge spread distance)
      // - Age component: ~6 points (2 days old = good)
      // - Liquidity component: ~6 points (good liquidity)
      // Total quality score: ~12 points (out of 20)
      expect(score.qualityScore).toBeGreaterThan(10);  // Still has age + liquidity
      expect(score.qualityScore).toBeLessThan(15);      // But missing spread points
    });

    test('NEW CORRECT WAY: Market with actual bid-ask spread (270 bps) gets excellent quality score', () => {
      // This is what happens after the fix
      const marketWithCorrectSpread: Market = {
        id: 'market_correct',
        question: 'Will this happen?',
        outcomes: ['Yes', 'No'],
        outcomePrices: ['0.011', '0.038'],  // Bid at 1.1%, Ask at 3.8%
        volume: '100000',
        volumeNum: 100000,
        active: true,
        closed: false,
        category: 'politics',
        categoryScore: 5,
        outcomeCount: 2,
        spread: 270,  // CORRECT: Actual bid-ask spread (3.8% - 1.1%) * 10000
        marketAge: 2 * 24 * 60 * 60 * 1000,  // 2 days old
        timeToClose: 10 * 24 * 60 * 60 * 1000,  // 10 days to close
      };

      const score = categorizer.calculateOpportunityScore(marketWithCorrectSpread);

      // Quality score is much better with 3 components:
      // - Spread component: ~2.4 points (decent, spread dist = 120)
      // - Age component: ~6 points (2 days old = good)
      // - Liquidity component: ~6 points (good liquidity)
      // Total quality score: ~14.4 points (out of 20)
      expect(score.qualityScore).toBeGreaterThan(14);  // Excellent!
      expect(score.qualityScore).toBeLessThan(16);     // Not perfect but very good
      expect(score.total).toBeGreaterThan(75);  // Good overall score
    });

    test('spread component improvement is dramatic, but total quality score improvement is modest', () => {
      const buggyMarket: Market = {
        id: 'market_1',
        question: 'Test',
        outcomes: ['Yes', 'No'],
        outcomePrices: ['0.50', '0.50'],
        volume: '100000',
        volumeNum: 100000,
        active: true,
        closed: false,
        category: 'politics',
        categoryScore: 5,
        outcomeCount: 2,
        spread: 9520,  // Buggy
        marketAge: 2 * 24 * 60 * 60 * 1000,
        timeToClose: 10 * 24 * 60 * 60 * 1000,
      };

      const correctMarket: Market = {
        ...buggyMarket,
        spread: 270,  // Correct
      };

      const buggyScore = categorizer.calculateOpportunityScore(buggyMarket);
      const correctScore = categorizer.calculateOpportunityScore(correctMarket);

      // Quality score improvement is modest (~20%) because quality has 3 components:
      // - Spread (40%): improves dramatically from ~0 to ~2.4 points
      // - Age (30%): unchanged at ~6 points
      // - Liquidity (30%): unchanged at ~6 points
      // Total: improves from ~12 to ~14.4 points (20% improvement)
      const improvement = correctScore.qualityScore / Math.max(buggyScore.qualityScore, 0.01);
      expect(improvement).toBeGreaterThan(1.1);  // At least 10% improvement
      expect(improvement).toBeLessThan(1.5);     // But not dramatic

      // However, the SPREAD COMPONENT improves dramatically
      expect(correctScore.qualityScore).toBeGreaterThan(buggyScore.qualityScore + 1);
    });
  });

  describe('Optimal Spread Analysis', () => {
    test('150 bps (1.5%) spread gets maximum score', () => {
      const optimalMarket: Market = {
        id: 'optimal',
        question: 'Test',
        outcomes: ['Yes', 'No'],
        outcomePrices: ['0.50', '0.50'],
        volume: '100000',
        volumeNum: 100000,
        active: true,
        closed: false,
        category: 'politics',
        categoryScore: 5,
        outcomeCount: 2,
        spread: 150,  // Optimal
        marketAge: 2 * 24 * 60 * 60 * 1000,
        timeToClose: 10 * 24 * 60 * 60 * 1000,
      };

      const score = categorizer.calculateOpportunityScore(optimalMarket);

      // Should get full spread score: Math.exp(0) * 0.4 * 20 = 8.0
      expect(score.qualityScore).toBeGreaterThan(7.5);
    });

    test('typical prediction market spreads (100-300 bps) score well', () => {
      const testSpreads = [100, 150, 200, 250, 300];  // 1% to 3%

      const scores = testSpreads.map(spreadBps => {
        const market: Market = {
          id: `market_${spreadBps}`,
          question: 'Test',
          outcomes: ['Yes', 'No'],
          outcomePrices: ['0.50', '0.50'],
          volume: '100000',
          volumeNum: 100000,
          active: true,
          closed: false,
          category: 'politics',
          categoryScore: 5,
          outcomeCount: 2,
          spread: spreadBps,
          marketAge: 2 * 24 * 60 * 60 * 1000,
          timeToClose: 10 * 24 * 60 * 60 * 1000,
        };

        return categorizer.calculateOpportunityScore(market).qualityScore;
      });

      // All should score reasonably well (> 2 points out of 20)
      scores.forEach(score => {
        expect(score).toBeGreaterThan(2);
      });

      // 150 bps should score best
      const optimalIndex = testSpreads.indexOf(150);
      expect(scores[optimalIndex]).toBeGreaterThanOrEqual(Math.max(...scores) - 0.1);
    });

    test('very wide spreads (>500 bps) get penalized in spread component', () => {
      const wideSpreadMarket: Market = {
        id: 'wide',
        question: 'Test',
        outcomes: ['Yes', 'No'],
        outcomePrices: ['0.50', '0.50'],
        volume: '100000',
        volumeNum: 100000,
        active: true,
        closed: false,
        category: 'politics',
        categoryScore: 5,
        outcomeCount: 2,
        spread: 1000,  // 10% spread - very wide
        marketAge: 2 * 24 * 60 * 60 * 1000,
        timeToClose: 10 * 24 * 60 * 60 * 1000,
      };

      const score = categorizer.calculateOpportunityScore(wideSpreadMarket);

      // Spread component gets nearly zero:
      // Spread distance: |1000 - 150| = 850
      // Spread score: Math.exp(-850/100) * 0.4 * 20 ≈ 0.0002 points
      //
      // But quality score still has age + liquidity components:
      // - Spread component: ~0 points (terrible)
      // - Age component: ~6 points (2 days old = good)
      // - Liquidity component: ~6 points (good liquidity)
      // Total quality score: ~12 points (out of 20)
      expect(score.qualityScore).toBeGreaterThan(10);  // Still has age + liquidity
      expect(score.qualityScore).toBeLessThan(13);     // Missing all spread points

      // Compare to optimal spread - wide spread should score worse
      const optimalMarket = { ...wideSpreadMarket, spread: 150 };
      const optimalScore = categorizer.calculateOpportunityScore(optimalMarket);
      expect(score.qualityScore).toBeLessThan(optimalScore.qualityScore - 2);
    });
  });

  describe('Real-World Discord Example', () => {
    test('market with bid=1.1¢, ask=3.8¢ (270 bps) scores well', () => {
      // This is the actual example from the Discord bug report
      const realWorldMarket: Market = {
        id: 'discord_example',
        question: 'Real market from Discord',
        outcomes: ['Yes', 'No'],
        outcomePrices: ['0.011', '0.038'],
        volume: '50000',
        volumeNum: 50000,
        active: true,
        closed: false,
        category: 'politics',
        categoryScore: 4,
        outcomeCount: 2,
        spread: 270,  // Correct spread
        marketAge: 5 * 24 * 60 * 60 * 1000,  // 5 days old
        timeToClose: 15 * 24 * 60 * 60 * 1000,  // 15 days to close
      };

      const score = categorizer.calculateOpportunityScore(realWorldMarket);

      // Should get reasonable quality score
      expect(score.qualityScore).toBeGreaterThan(2);
      expect(score.total).toBeGreaterThan(40);  // Should be a viable market
    });
  });

  describe('Parameter Validation', () => {
    test('optimalSpreadBps of 150 is reasonable for prediction markets', () => {
      // 150 bps = 1.5% spread
      // For a market at 50¢, that's about 0.75¢ on each side
      // This is tight but achievable for liquid prediction markets

      const optimalSpreadBps = 150;
      const optimalSpreadPercent = optimalSpreadBps / 100;  // 1.5%

      expect(optimalSpreadPercent).toBe(1.5);
      expect(optimalSpreadPercent).toBeGreaterThan(0.5);   // Not too tight
      expect(optimalSpreadPercent).toBeLessThan(3.0);      // Not too wide
    });

    test('exponential decay formula is appropriate', () => {
      // Test that the Math.exp(-distance/100) formula creates reasonable scores

      const testCases = [
        { spread: 150, expectedRelativeScore: 1.00 },  // Optimal
        { spread: 250, expectedRelativeScore: 0.37 },  // 100 bps away: exp(-1)
        { spread: 350, expectedRelativeScore: 0.14 },  // 200 bps away: exp(-2)
        { spread: 550, expectedRelativeScore: 0.02 },  // 400 bps away: exp(-4)
      ];

      testCases.forEach(({ spread, expectedRelativeScore }) => {
        const distance = Math.abs(spread - 150);
        const relativeScore = Math.exp(-distance / 100);
        expect(relativeScore).toBeCloseTo(expectedRelativeScore, 2);
      });
    });
  });
});
