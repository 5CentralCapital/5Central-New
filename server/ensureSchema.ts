/**
 * Runtime schema check — ensures all PostgreSQL tables exist.
 * This is a safety net in case `drizzle-kit push` didn't run or failed.
 * Uses CREATE TABLE IF NOT EXISTS so it's safe to run repeatedly.
 */
import { pool } from "./db";

export async function ensureSchema() {
  const client = await pool.connect();
  try {
    console.log("[schema] Checking database tables...");

    // Check if the core 'users' table exists
    const check = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'users'
      );
    `);

    if (check.rows[0].exists) {
      // Also check a newer table (loans) to see if schema is up to date
      const checkNew = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'loans'
        );
      `);

      if (checkNew.rows[0].exists) {
        console.log("[schema] All tables present ✓");
        return;
      }
      console.log("[schema] Core tables exist but newer tables missing — creating them now...");
    } else {
      console.log("[schema] No tables found — creating full schema...");
    }

    // Create all tables (IF NOT EXISTS makes this safe)
    await client.query(`
      -- Core tables
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'investor',
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS investors (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id VARCHAR NOT NULL REFERENCES users(id),
        accredited_status TEXT NOT NULL DEFAULT 'pending',
        invested_amount DECIMAL(12,2) DEFAULT 0,
        phone TEXT,
        investor_type TEXT NOT NULL DEFAULT 'deal-investor',
        company_equity_percentage DECIMAL(5,4)
      );

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
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        equity_percentage DECIMAL(5,4),
        property_id VARCHAR,
        initial_investment DECIMAL(12,2),
        current_equity_value DECIMAL(12,2),
        cash_out_at_refi DECIMAL(12,2),
        projected_exit_value DECIMAL(12,2),
        equity_multiple DECIMAL(4,2)
      );

      CREATE TABLE IF NOT EXISTS properties (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        address TEXT NOT NULL,
        city TEXT NOT NULL,
        state TEXT NOT NULL,
        zip_code TEXT NOT NULL,
        units INTEGER NOT NULL,
        acquisition_date TIMESTAMP NOT NULL,
        acquisition_price DECIMAL(12,2) NOT NULL,
        rehab_costs DECIMAL(12,2) DEFAULT 0,
        current_value DECIMAL(12,2),
        sale_price DECIMAL(12,2),
        sale_date TIMESTAMP,
        total_cashflow DECIMAL(12,2) DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'current',
        ownership_structure TEXT NOT NULL,
        ownership_name TEXT NOT NULL,
        years_held DECIMAL(4,2),
        irr DECIMAL(5,2),
        equity_multiple DECIMAL(4,2),
        noi DECIMAL(12,2),
        debt_service DECIMAL(12,2),
        cashflow DECIMAL(12,2),
        current_debt DECIMAL(12,2),
        refi_date TIMESTAMP,
        projected_sale_date TIMESTAMP,
        image_url TEXT,
        year_built TEXT,
        building_sf TEXT,
        closing_date TEXT,
        investment_thesis TEXT,
        in_place_noi DECIMAL(12,2),
        stabilized_noi DECIMAL(12,2),
        noi_upside DECIMAL(12,2),
        cap_rate_in_place DECIMAL(6,4),
        cap_rate_stabilized DECIMAL(6,4),
        entry_cap_rate DECIMAL(6,4),
        exit_cap_rate DECIMAL(6,4),
        cap_rate_spread DECIMAL(6,4),
        value_creation DECIMAL(12,2),
        entry_per_unit DECIMAL(12,2),
        exit_per_unit DECIMAL(12,2),
        arv_per_unit DECIMAL(12,2),
        arv_total DECIMAL(12,2),
        bridge_loan DECIMAL(12,2),
        ltv_purchase DECIMAL(6,4),
        ltc DECIMAL(6,4),
        interest_rate DECIMAL(6,4),
        rehab_holdback DECIMAL(12,2),
        total_commitment DECIMAL(12,2),
        monthly_pi DECIMAL(12,2),
        annual_debt_service DECIMAL(12,2),
        maturity_date TEXT,
        loan_type TEXT,
        irr_levered TEXT,
        moic DECIMAL(6,2),
        yield_on_cost DECIMAL(6,4),
        cash_yield_stabilized DECIMAL(6,4),
        payback_period DECIMAL(6,1),
        hold_period TEXT,
        refi_month INTEGER,
        sponsor_equity DECIMAL(12,2),
        breakeven_occupancy DECIMAL(6,4),
        dscr_stabilized DECIMAL(6,2),
        debt_yield DECIMAL(6,4),
        cash_out_at_refi DECIMAL(12,2),
        net_cash_from_sale DECIMAL(12,2),
        total_profit DECIMAL(12,2),
        total_units INTEGER,
        occupied_units INTEGER,
        occupancy_rate DECIMAL(6,4),
        in_place_rent DECIMAL(12,2),
        proforma_rent DECIMAL(12,2),
        rent_upside DECIMAL(12,2),
        refi_ltv DECIMAL(6,4),
        refi_loan_amount DECIMAL(12,2),
        refi_cash_out DECIMAL(12,2),
        new_monthly_pi DECIMAL(12,2),
        equity_after_refi DECIMAL(12,2),
        refi_target_month INTEGER,
        projected_sale_price DECIMAL(12,2),
        projected_net_proceeds DECIMAL(12,2),
        projected_total_profit DECIMAL(12,2),
        hold_period_months INTEGER,
        before_photos TEXT,
        after_photos TEXT,
        initial_capital_required DECIMAL(12,2),
        total_cashflow_collected DECIMAL(12,2),
        sale_proceeds DECIMAL(12,2),
        cash_on_cash DECIMAL(8,2),
        total_return_percent DECIMAL(8,2),
        appreciation_percent DECIMAL(8,2),
        price_per_unit DECIMAL(12,2),
        total_basis DECIMAL(12,2),
        gross_profit DECIMAL(12,2),
        roc DECIMAL(8,2),
        avg_annual_return DECIMAL(8,2),
        profit_per_unit DECIMAL(12,2),
        phase TEXT,
        lender TEXT,
        refi_target TEXT,
        monthly_rent DECIMAL(12,2),
        occupancy_status TEXT
      );

      -- Dashboard tables
      CREATE TABLE IF NOT EXISTS dashboard_tasks (
        id VARCHAR PRIMARY KEY,
        title TEXT NOT NULL,
        due_date TEXT,
        cadence TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        property TEXT,
        module TEXT NOT NULL DEFAULT 'reminders',
        priority TEXT DEFAULT 'medium',
        notes TEXT
      );

      CREATE TABLE IF NOT EXISTS dashboard_rehab (
        id VARCHAR PRIMARY KEY,
        property TEXT NOT NULL,
        project TEXT NOT NULL,
        budget DECIMAL(12,2) NOT NULL,
        spent DECIMAL(12,2) NOT NULL DEFAULT 0,
        completion_pct INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'not_started',
        target_date TEXT,
        notes TEXT
      );

      CREATE TABLE IF NOT EXISTS dashboard_growth (
        id VARCHAR PRIMARY KEY,
        year INTEGER NOT NULL,
        target_units INTEGER NOT NULL,
        target_aum DECIMAL(14,2) NOT NULL,
        target_equity DECIMAL(14,2) NOT NULL,
        phase TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planned'
      );

      CREATE TABLE IF NOT EXISTS dashboard_kpis (
        id VARCHAR PRIMARY KEY,
        name TEXT NOT NULL,
        current_value DECIMAL(14,4) NOT NULL,
        previous_value DECIMAL(14,4) NOT NULL,
        target_value DECIMAL(14,4) NOT NULL,
        unit TEXT,
        format TEXT,
        property TEXT,
        date TEXT
      );

      CREATE TABLE IF NOT EXISTS dashboard_metrics (
        id VARCHAR PRIMARY KEY,
        label TEXT NOT NULL,
        value DECIMAL(14,4) NOT NULL,
        unit TEXT,
        trend DECIMAL(8,4),
        target DECIMAL(14,4),
        format TEXT
      );

      CREATE TABLE IF NOT EXISTS dashboard_activity (
        id VARCHAR PRIMARY KEY,
        ts TIMESTAMP DEFAULT NOW() NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        detail TEXT NOT NULL
      );

      -- Module tables
      CREATE TABLE IF NOT EXISTS workers (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        phone TEXT,
        email TEXT,
        default_rate DECIMAL(8,2) NOT NULL,
        payment_method TEXT NOT NULL DEFAULT 'zelle',
        payment_handle TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        hire_date TIMESTAMP DEFAULT NOW() NOT NULL,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS payroll_entries (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        worker_id VARCHAR NOT NULL REFERENCES workers(id),
        property_id VARCHAR REFERENCES properties(id),
        unit_number TEXT,
        task TEXT NOT NULL,
        date TEXT NOT NULL,
        hours DECIMAL(5,2) NOT NULL,
        rate DECIMAL(8,2) NOT NULL,
        total DECIMAL(10,2) NOT NULL,
        week_ending TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS payroll_payments (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        worker_id VARCHAR NOT NULL REFERENCES workers(id),
        amount DECIMAL(10,2) NOT NULL,
        payment_method TEXT NOT NULL,
        memo TEXT,
        reference TEXT,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        paid_at TIMESTAMP DEFAULT NOW() NOT NULL,
        status TEXT NOT NULL DEFAULT 'paid',
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rehab_line_items (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        property_id VARCHAR NOT NULL REFERENCES properties(id),
        unit_number TEXT,
        scope_item TEXT NOT NULL,
        category TEXT NOT NULL,
        contractor_baseline_cost DECIMAL(10,2),
        in_house_labor_cost DECIMAL(10,2) DEFAULT 0,
        in_house_material_cost DECIMAL(10,2) DEFAULT 0,
        total_in_house_cost DECIMAL(10,2) DEFAULT 0,
        savings_vs_contractor DECIMAL(10,2) DEFAULT 0,
        savings_percent DECIMAL(5,2) DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'planned',
        assigned_worker_id VARCHAR REFERENCES workers(id),
        planned_start_date TEXT,
        planned_end_date TEXT,
        actual_start_date TEXT,
        actual_end_date TEXT,
        slip_days INTEGER DEFAULT 0,
        is_critical_path BOOLEAN DEFAULT FALSE,
        blocker_reason TEXT,
        proof_url TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rehab_material_log (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        property_id VARCHAR NOT NULL REFERENCES properties(id),
        line_item_id VARCHAR REFERENCES rehab_line_items(id),
        description TEXT NOT NULL,
        vendor TEXT,
        cost DECIMAL(10,2) NOT NULL,
        receipt_url TEXT,
        purchase_date TEXT NOT NULL,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rehab_photos (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        property_id VARCHAR NOT NULL REFERENCES properties(id),
        unit_number TEXT,
        line_item_id VARCHAR REFERENCES rehab_line_items(id),
        photo_url TEXT NOT NULL,
        caption TEXT,
        phase TEXT NOT NULL,
        taken_at TIMESTAMP DEFAULT NOW() NOT NULL,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS unit_rent_roll (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        property_id VARCHAR NOT NULL REFERENCES properties(id),
        unit_number TEXT NOT NULL,
        bedrooms INTEGER,
        bathrooms DECIMAL(3,1),
        sqft INTEGER,
        tenant_name TEXT,
        lease_start TEXT,
        lease_end TEXT,
        monthly_rent DECIMAL(8,2),
        market_rent DECIMAL(8,2),
        security_deposit DECIMAL(8,2),
        status TEXT NOT NULL DEFAULT 'vacant',
        move_in_date TEXT,
        move_out_date TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS vacancy_pipeline (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        unit_id VARCHAR NOT NULL REFERENCES unit_rent_roll(id),
        property_id VARCHAR NOT NULL REFERENCES properties(id),
        unit_number TEXT NOT NULL,
        vacancy_start_date TEXT NOT NULL,
        days_vacant INTEGER DEFAULT 0,
        turn_status TEXT NOT NULL DEFAULT 'not_started',
        target_ready_date TEXT,
        target_lease_date TEXT,
        asking_rent DECIMAL(8,2),
        market_comps DECIMAL(8,2),
        showings_count INTEGER DEFAULT 0,
        applications_count INTEGER DEFAULT 0,
        urgency TEXT DEFAULT 'normal',
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS turn_checklist (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        vacancy_id VARCHAR NOT NULL REFERENCES vacancy_pipeline(id),
        step TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        is_complete BOOLEAN DEFAULT FALSE,
        completed_at TIMESTAMP,
        completed_by TEXT,
        due_date TEXT,
        notes TEXT
      );

      CREATE TABLE IF NOT EXISTS pm_notes (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        property_id VARCHAR NOT NULL REFERENCES properties(id),
        author TEXT NOT NULL,
        date TEXT NOT NULL,
        content TEXT NOT NULL,
        category TEXT DEFAULT 'general',
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pm_escalations (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        property_id VARCHAR REFERENCES properties(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'medium',
        trigger TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        escalated_by TEXT NOT NULL,
        resolved_by TEXT,
        resolved_at TIMESTAMP,
        spend_amount DECIMAL(10,2),
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sla_timers (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        property_id VARCHAR REFERENCES properties(id),
        sla_type TEXT NOT NULL,
        target_hours INTEGER NOT NULL,
        started_at TIMESTAMP NOT NULL,
        completed_at TIMESTAMP,
        is_breached BOOLEAN DEFAULT FALSE,
        related_entity_type TEXT,
        related_entity_id VARCHAR,
        assigned_to TEXT,
        notes TEXT
      );

      CREATE TABLE IF NOT EXISTS investor_documents (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        investor_id VARCHAR REFERENCES investors(id),
        property_id VARCHAR REFERENCES properties(id),
        title TEXT NOT NULL,
        description TEXT,
        doc_type TEXT NOT NULL,
        file_url TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_size INTEGER,
        year INTEGER,
        quarter INTEGER,
        status TEXT NOT NULL DEFAULT 'available',
        uploaded_by TEXT NOT NULL,
        download_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS distributions (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        investor_id VARCHAR NOT NULL REFERENCES investors(id),
        investment_id VARCHAR REFERENCES investments(id),
        property_id VARCHAR REFERENCES properties(id),
        amount DECIMAL(12,2) NOT NULL,
        distribution_type TEXT NOT NULL,
        period TEXT,
        payment_method TEXT,
        payment_reference TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        paid_at TIMESTAMP,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS waterfall_tiers (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        investment_id VARCHAR REFERENCES investments(id),
        property_id VARCHAR REFERENCES properties(id),
        tier_order INTEGER NOT NULL,
        tier_name TEXT NOT NULL,
        hurdle_rate DECIMAL(6,4),
        lp_split DECIMAL(5,2),
        gp_split DECIMAL(5,2),
        description TEXT
      );

      CREATE TABLE IF NOT EXISTS capital_accounts (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        investor_id VARCHAR NOT NULL REFERENCES investors(id),
        investment_id VARCHAR REFERENCES investments(id),
        property_id VARCHAR REFERENCES properties(id),
        period TEXT NOT NULL,
        beginning_balance DECIMAL(14,2) NOT NULL,
        contributions DECIMAL(12,2) DEFAULT 0,
        distributions_paid DECIMAL(12,2) DEFAULT 0,
        allocated_income DECIMAL(12,2) DEFAULT 0,
        allocated_loss DECIMAL(12,2) DEFAULT 0,
        appreciation_allocation DECIMAL(12,2) DEFAULT 0,
        ending_balance DECIMAL(14,2) NOT NULL,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS property_monthly_data (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        property_id VARCHAR NOT NULL REFERENCES properties(id),
        month TEXT NOT NULL,
        actual_rent_collected DECIMAL(12,2),
        proforma_rent DECIMAL(12,2),
        vacancy_count INTEGER,
        occupied_count INTEGER,
        operating_expenses DECIMAL(12,2),
        actual_noi DECIMAL(12,2),
        proforma_noi DECIMAL(12,2),
        debt_service_paid DECIMAL(12,2),
        net_cashflow DECIMAL(12,2),
        distributions_paid DECIMAL(12,2),
        rehab_spend DECIMAL(12,2),
        variance_notes TEXT,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS deal_pipeline (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        address TEXT,
        city TEXT,
        state TEXT,
        units INTEGER,
        asking_price DECIMAL(12,2),
        offer_price DECIMAL(12,2),
        projected_noi DECIMAL(12,2),
        projected_cap_rate DECIMAL(6,4),
        projected_irr DECIMAL(6,2),
        stage TEXT NOT NULL DEFAULT 'sourced',
        source TEXT,
        broker_name TEXT,
        broker_contact TEXT,
        loi_date TEXT,
        contract_date TEXT,
        dd_deadline TEXT,
        closing_date TEXT,
        dead_reason TEXT,
        equity_needed DECIMAL(12,2),
        financing_strategy TEXT,
        investment_thesis TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS investor_leads (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT,
        company TEXT,
        accredited_status TEXT DEFAULT 'unknown',
        investable_capital DECIMAL(14,2),
        source TEXT,
        referred_by TEXT,
        stage TEXT NOT NULL DEFAULT 'new',
        interest_level TEXT DEFAULT 'medium',
        notes TEXT,
        last_contact_date TEXT,
        next_follow_up_date TEXT,
        converted_to_investor_id VARCHAR REFERENCES investors(id),
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS investor_communications (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        investor_id VARCHAR REFERENCES investors(id),
        lead_id VARCHAR REFERENCES investor_leads(id),
        type TEXT NOT NULL,
        direction TEXT NOT NULL DEFAULT 'outbound',
        subject TEXT,
        content TEXT,
        sent_at TIMESTAMP DEFAULT NOW() NOT NULL,
        sent_by TEXT,
        status TEXT DEFAULT 'sent',
        related_document_id VARCHAR REFERENCES investor_documents(id),
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS loans (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        property_name TEXT NOT NULL,
        property_id VARCHAR REFERENCES properties(id),
        lender TEXT NOT NULL,
        loan_type TEXT DEFAULT 'bridge',
        balance DECIMAL(14,2) NOT NULL,
        interest_rate DECIMAL(8,5),
        monthly_payment DECIMAL(12,2),
        maturity_date TEXT,
        term TEXT,
        interest_only BOOLEAN DEFAULT TRUE,
        origination_fee DECIMAL(10,2),
        exit_fee DECIMAL(8,4),
        loan_to_value DECIMAL(6,4),
        status TEXT NOT NULL DEFAULT 'active',
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS maintenance_requests (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        property_id VARCHAR NOT NULL REFERENCES properties(id),
        unit_number TEXT,
        tenant_name TEXT,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'medium',
        status TEXT NOT NULL DEFAULT 'open',
        assigned_to TEXT,
        estimated_cost DECIMAL(10,2),
        actual_cost DECIMAL(10,2),
        reported_at TIMESTAMP DEFAULT NOW() NOT NULL,
        acknowledged_at TIMESTAMP,
        scheduled_date TEXT,
        completed_at TIMESTAMP,
        photo_urls TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
    `);

    console.log("[schema] All tables created ✓");
  } catch (error) {
    console.error("[schema] Error ensuring schema:", error);
    throw error;
  } finally {
    client.release();
  }
}
