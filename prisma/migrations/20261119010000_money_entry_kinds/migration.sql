-- Kinds of money entry the business adds itself ("Bonus", "Tea money", "Fine"...), on top of the five built-in
-- ones (Payment, Advance, Expense, Credit, Money received back). Each kind fixes which way it moves the balance.
CREATE TABLE money_entry_kinds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 40),
  -- +1 adds to what the business owes the person, -1 takes from it.
  sign smallint NOT NULL CHECK (sign IN (-1, 1)),
  -- Cash/bank/wallet changes hands, so "Paid by" is asked.
  moves_money boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Names are unique ignoring case and spacing; built-in labels are blocked in code.
CREATE UNIQUE INDEX money_entry_kinds_name_key ON money_entry_kinds (lower(regexp_replace(btrim(name), '\s+', ' ', 'g')));

ALTER TABLE karigar_ledger ADD COLUMN kind_id uuid REFERENCES money_entry_kinds (id);

ALTER TABLE karigar_ledger DROP CONSTRAINT karigar_ledger_type_check;
ALTER TABLE karigar_ledger ADD CONSTRAINT karigar_ledger_type_check CHECK (type IN (
  'EARNING', 'EARNING_REVERSAL', 'PAYMENT', 'ADVANCE', 'EXPENSE', 'CREDIT', 'RECOVERY', 'OTHER_PLUS', 'OTHER_MINUS',
  'ENTRY_REVERSAL'
));

-- A custom-kind entry names its kind; built-in entries never do.
ALTER TABLE karigar_ledger ADD CONSTRAINT karigar_ledger_kind_check
  CHECK ((type IN ('OTHER_PLUS', 'OTHER_MINUS')) = (kind_id IS NOT NULL));

-- A custom kind's direction is fixed by its type: OTHER_PLUS adds to the balance, OTHER_MINUS takes from it.
ALTER TABLE karigar_ledger DROP CONSTRAINT karigar_ledger_sign;
ALTER TABLE karigar_ledger ADD CONSTRAINT karigar_ledger_sign CHECK (
  CASE type
    WHEN 'EARNING' THEN amount >= 0
    WHEN 'CREDIT' THEN amount > 0
    WHEN 'RECOVERY' THEN amount > 0
    WHEN 'OTHER_PLUS' THEN amount > 0
    WHEN 'ENTRY_REVERSAL' THEN amount <> 0
    ELSE amount < 0
  END
);
