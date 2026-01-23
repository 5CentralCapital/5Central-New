import 'dotenv/config';
import { pool } from './db';

async function migrate() {
  console.log('Running migration...');
  const client = await pool.connect();
  try {
    // Add new columns to users table
    console.log('Adding columns to users table...');
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS email TEXT,
      ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'investor',
      ADD COLUMN IF NOT EXISTS first_name TEXT,
      ADD COLUMN IF NOT EXISTS last_name TEXT,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
    `);

    // Copy username to email if email is null
    console.log('Copying username to email...');
    await client.query(`
      UPDATE users SET email = username WHERE email IS NULL;
    `);

    // Set defaults for first_name and last_name if null
    await client.query(`
      UPDATE users SET first_name = 'User' WHERE first_name IS NULL;
      UPDATE users SET last_name = '' WHERE last_name IS NULL;
    `);

    // Make columns not null
    console.log('Setting constraints...');
    await client.query(`
      ALTER TABLE users
      ALTER COLUMN first_name SET NOT NULL,
      ALTER COLUMN last_name SET NOT NULL,
      ALTER COLUMN role SET NOT NULL;
    `);

    // Add unique constraint on email if not exists
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_email_unique') THEN
          ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE (email);
        END IF;
      END $$;
    `);

    // Create investors table
    console.log('Creating investors table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS investors (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id VARCHAR NOT NULL REFERENCES users(id),
        accredited_status TEXT NOT NULL DEFAULT 'pending',
        invested_amount DECIMAL(12,2) DEFAULT 0,
        phone TEXT
      );
    `);

    // Add investor type fields to investors table
    console.log('Adding investor type fields to investors table...');
    await client.query(`
      ALTER TABLE investors
      ADD COLUMN IF NOT EXISTS investor_type TEXT NOT NULL DEFAULT 'deal-investor',
      ADD COLUMN IF NOT EXISTS company_equity_percentage DECIMAL(5,4);
    `);

    // Create investments table
    console.log('Creating investments table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS investments (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        investor_id VARCHAR NOT NULL REFERENCES investors(id),
        property_name TEXT NOT NULL,
        property_address TEXT,
        principal DECIMAL(12,2) NOT NULL,
        balloon_amount DECIMAL(12,2),
        monthly_payment DECIMAL(12,2),
        return_multiple DECIMAL(4,2),
        interest_rate DECIMAL(5,4),
        effective_date TIMESTAMP,
        maturity_date TIMESTAMP,
        term TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        investment_type TEXT NOT NULL DEFAULT 'deal-specific',
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
    `);

    // Add equity investment fields to investments table
    console.log('Adding equity investment fields to investments table...');
    await client.query(`
      ALTER TABLE investments
      ADD COLUMN IF NOT EXISTS equity_percentage DECIMAL(5,4),
      ADD COLUMN IF NOT EXISTS property_id VARCHAR,
      ADD COLUMN IF NOT EXISTS initial_investment DECIMAL(12,2),
      ADD COLUMN IF NOT EXISTS current_equity_value DECIMAL(12,2),
      ADD COLUMN IF NOT EXISTS cash_out_at_refi DECIMAL(12,2),
      ADD COLUMN IF NOT EXISTS projected_exit_value DECIMAL(12,2),
      ADD COLUMN IF NOT EXISTS equity_multiple DECIMAL(4,2);
    `);

    // Add debt and timeline fields to properties table
    console.log('Adding debt and timeline fields to properties table...');
    await client.query(`
      ALTER TABLE properties
      ADD COLUMN IF NOT EXISTS current_debt DECIMAL(12,2),
      ADD COLUMN IF NOT EXISTS refi_date TIMESTAMP,
      ADD COLUMN IF NOT EXISTS projected_sale_date TIMESTAMP,
      ADD COLUMN IF NOT EXISTS image_url TEXT;
    `);

    // Create session table
    console.log('Creating session table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        sid VARCHAR NOT NULL PRIMARY KEY,
        sess JSON NOT NULL,
        expire TIMESTAMP(6) NOT NULL
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS IDX_session_expire ON user_sessions (expire);
    `);

    console.log('Migration complete!');
  } catch (error) {
    console.error('Migration error:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((e) => {
  console.error(e);
  process.exit(1);
});
