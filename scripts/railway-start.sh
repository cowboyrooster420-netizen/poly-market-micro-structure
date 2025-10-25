#!/bin/sh
# Railway startup script

echo "🚀 Starting Polymarket Bot Deployment"

# Run migration
echo "📦 Running database migration..."
node dist/scripts/migrate-database.js
MIGRATION_EXIT_CODE=$?

if [ $MIGRATION_EXIT_CODE -ne 0 ]; then
  echo "❌ Migration failed with exit code $MIGRATION_EXIT_CODE"
  exit 1
fi

echo "✅ Migration completed successfully"

# Start bot
echo "🤖 Starting bot..."
exec npm start
