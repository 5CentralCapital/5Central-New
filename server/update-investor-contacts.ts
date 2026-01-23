import 'dotenv/config';
import { pool } from './db';

// Real contact info from contracts
const contactUpdates = [
  {
    firstName: 'Benny',
    lastName: 'Duverge',
    newEmail: 'benny.com@icloud.com',
    phone: '860-389-7036',
  },
  {
    firstName: 'Mercedes',
    lastName: 'Gonzalez',
    newEmail: 'mercedesgonzalez531@gmail.com',
    phone: '+1 (203) 954-9773',
  },
  {
    firstName: 'Marquez',
    lastName: 'Hamilton',
    newEmail: 'marquezhamilton13@gmail.com',
    phone: '860-235-1263',
  },
  {
    firstName: 'Mahendra',
    lastName: 'Patel',
    newEmail: 'mpatel90@yahoo.com',
    phone: '860-501-2922',
  },
  {
    firstName: 'Vishwa',
    lastName: 'Patel',
    newEmail: 'vishp203@gmail.com',
    phone: '+1 (860) 268-0567',
  },
  {
    firstName: 'Coty',
    lastName: 'Roberts',
    newEmail: 'coty.roberts@gmail.com',
    phone: '+1 (860) 617-7053',
  },
];

async function updateContacts() {
  console.log('Updating investor contact information...\n');
  const client = await pool.connect();

  try {
    for (const contact of contactUpdates) {
      console.log(`Updating ${contact.firstName} ${contact.lastName}...`);

      // Update user email
      const userResult = await client.query(
        `UPDATE users
         SET email = $1
         WHERE first_name = $2 AND last_name = $3
         RETURNING id, email`,
        [contact.newEmail, contact.firstName, contact.lastName]
      );

      if (userResult.rows.length > 0) {
        const userId = userResult.rows[0].id;
        console.log(`  Email updated to: ${contact.newEmail}`);

        // Update investor phone
        if (contact.phone) {
          await client.query(
            `UPDATE investors SET phone = $1 WHERE user_id = $2`,
            [contact.phone, userId]
          );
          console.log(`  Phone updated to: ${contact.phone}`);
        }
      } else {
        console.log(`  User not found (may not exist yet)`);
      }
    }

    console.log('\n✓ Contact updates complete!');
    console.log('\nUpdated login emails:');
    for (const contact of contactUpdates) {
      console.log(`  ${contact.firstName} ${contact.lastName}: ${contact.newEmail}`);
    }
  } catch (error) {
    console.error('Update error:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

updateContacts().catch((e) => {
  console.error(e);
  process.exit(1);
});
