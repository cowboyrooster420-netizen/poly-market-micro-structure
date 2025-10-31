#!/usr/bin/env ts-node

/**
 * Quick diagnostic script to check markets with missing asset IDs
 */

import { DatabaseManager } from '../src/data/database';

async function main() {
  const dbPath = process.env.SQLITE_PATH || './data/polymarket.db';

  const database = new DatabaseManager({
    provider: 'sqlite',
    database: dbPath
  });

  await database.initialize();

  // Count total markets
  const totalResult = await database.query('SELECT COUNT(*) as count FROM markets');
  const totalMarkets = totalResult[0].count;

  // Count markets with metadata
  const withMetadataResult = await database.query(
    "SELECT COUNT(*) as count FROM markets WHERE metadata IS NOT NULL AND metadata != ''"
  );
  const withMetadata = withMetadataResult[0].count;

  // Get sample of markets with no asset IDs
  const noAssetIdsResult = await database.query(`
    SELECT id, question, metadata
    FROM markets
    WHERE metadata IS NULL
       OR metadata = ''
       OR metadata = '{}'
       OR json_extract(metadata, '$.assetIds') IS NULL
       OR json_extract(metadata, '$.assetIds') = '[]'
    LIMIT 10
  `);

  // Count markets with no asset IDs
  const noAssetIdsCount = await database.query(`
    SELECT COUNT(*) as count
    FROM markets
    WHERE metadata IS NULL
       OR metadata = ''
       OR metadata = '{}'
       OR json_extract(metadata, '$.assetIds') IS NULL
       OR json_extract(metadata, '$.assetIds') = '[]'
  `);

  const missingAssetIds = noAssetIdsCount[0].count;

  console.log('═'.repeat(80));
  console.log('MARKET ASSET ID DIAGNOSTIC');
  console.log('═'.repeat(80));
  console.log('');
  console.log(`Total Markets: ${totalMarkets}`);
  console.log(`Markets with Metadata: ${withMetadata}`);
  console.log(`Markets Missing Asset IDs: ${missingAssetIds}`);
  console.log(`Percentage Missing: ${((missingAssetIds / totalMarkets) * 100).toFixed(1)}%`);
  console.log('');

  if (noAssetIdsResult.length > 0) {
    console.log('Sample Markets Missing Asset IDs:');
    console.log('-'.repeat(80));
    for (const market of noAssetIdsResult) {
      console.log(`ID: ${market.id}`);
      console.log(`Question: ${market.question || 'N/A'}`);
      console.log(`Metadata: ${market.metadata || 'NULL'}`);
      console.log('-'.repeat(80));
    }
  }

  await database.close();
}

main().catch(console.error);
