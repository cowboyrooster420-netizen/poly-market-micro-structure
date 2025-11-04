const sqlite3 = require('sqlite3');
const path = require('path');

const dbPath = path.join(process.cwd(), 'data', 'polymarket.db');

console.log('📊 Checking database:', dbPath);
console.log('═'.repeat(80));

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error('❌ Error opening database:', err.message);
    process.exit(1);
  }

  console.log('✅ Database opened successfully\n');

  // Check the signals table specifically
  const tableName = 'signals';

  console.log(`🔍 Analyzing '${tableName}' table:\n`);

  // Get table schema
  db.all(`PRAGMA table_info(${tableName})`, [], (err, columns) => {
    if (err) {
      console.error('Error getting schema:', err.message);
      db.close();
      return;
    }

    console.log('Columns:');
    columns.forEach(col => {
      console.log(`  - ${col.name} (${col.type})`);
    });
    console.log('');

    // Get total count
    db.get(`SELECT COUNT(*) as count FROM ${tableName}`, [], (err, row) => {
      if (err) {
        console.error('Error counting signals:', err.message);
        db.close();
        return;
      }

      console.log(`📈 Total signals stored: ${row.count}\n`);

      if (row.count === 0) {
        console.log('⚠️  No signals found in database yet.\n');
        console.log('This could mean:');
        console.log('  1. Bot hasn\'t detected any signals yet (need more time/data)');
        console.log('  2. Bot is not running');
        console.log('  3. Signals are being detected but not saved (check logs for errors)\n');
        db.close();
        return;
      }

      // Get signal type breakdown
      db.all(`
        SELECT
          signalType as type,
          COUNT(*) as count,
          AVG(confidence) as avg_confidence,
          MAX(timestamp) as last_seen
        FROM ${tableName}
        GROUP BY signalType
        ORDER BY count DESC
      `, [], (err, types) => {
        if (err) {
          console.error('Error getting signal types:', err.message);
          db.close();
          return;
        }

        console.log('Signal Type Breakdown:');
        console.log('─'.repeat(80));
        console.log(
          'Type'.padEnd(30) +
          'Count'.padEnd(10) +
          'Avg Conf'.padEnd(15) +
          'Last Seen'
        );
        console.log('─'.repeat(80));

        types.forEach(t => {
          const timeAgo = ((Date.now() - t.last_seen) / 1000 / 60).toFixed(0);
          console.log(
            t.type.padEnd(30) +
            t.count.toString().padEnd(10) +
            (t.avg_confidence * 100).toFixed(1).padEnd(13) + '%' +
            `  ${timeAgo}min ago`
          );
        });
        console.log('─'.repeat(80));
        console.log('');

        // Get recent signals
        db.all(`
          SELECT
            signalType,
            marketId,
            confidence,
            timestamp,
            metadata
          FROM ${tableName}
          ORDER BY timestamp DESC
          LIMIT 10
        `, [], (err, recent) => {
          if (err) {
            console.error('Error getting recent signals:', err.message);
            db.close();
            return;
          }

          console.log('🕒 Most Recent 10 Signals:');
          console.log('─'.repeat(80));

          recent.forEach((signal, i) => {
            const date = new Date(signal.timestamp);
            const timeAgo = ((Date.now() - signal.timestamp) / 1000 / 60).toFixed(0);
            console.log(`${i + 1}. ${signal.signalType}`);
            console.log(`   Market: ${signal.marketId.substring(0, 16)}...`);
            console.log(`   Confidence: ${(signal.confidence * 100).toFixed(1)}%`);
            console.log(`   Time: ${date.toISOString()} (${timeAgo}min ago)`);
            if (signal.metadata) {
              try {
                const meta = JSON.parse(signal.metadata);
                if (meta.severity) console.log(`   Severity: ${meta.severity}`);
                if (meta.volumeChangePercent) console.log(`   Volume Change: ${meta.volumeChangePercent.toFixed(1)}%`);
                if (meta.maxChange) console.log(`   Price Change: ${meta.maxChange.toFixed(1)}%`);
              } catch (e) {
                // ignore parse errors
              }
            }
            console.log('');
          });

          console.log('═'.repeat(80));
          console.log('✅ Database check complete\n');

          db.close();
        });
      });
    });
  });
});
