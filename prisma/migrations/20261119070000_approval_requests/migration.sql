-- Corrections that need approval (Settings → Approval rules). A request names the posted record and
-- the change; approving runs the same reversal/adjustment the screen would have run, as the approver.
-- Rows are never deleted; decided requests keep who decided, when and why.
CREATE TABLE approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  type text NOT NULL CHECK (type IN (
    'PURCHASE_REVERSAL', 'FABRIC_ADJUSTMENT', 'CUTTING_REVERSAL', 'STITCHING_ISSUE_REVERSAL',
    'STITCHING_RECEIPT_REVERSAL', 'PACKING_REVERSAL', 'DISPATCH_REVERSAL', 'GODOWN_ADJUSTMENT', 'PAYMENT_REVERSAL'
  )),
  -- The record to reverse, or the fabric / item to adjust.
  target_id uuid NOT NULL,
  -- What the screen sent (reason, adjustment quantity...), replayed on approval.
  payload jsonb NOT NULL,
  -- Human text: the record ("FI-0011 · Jersey 40 kg") and the change ("Posted → Reversed").
  title text NOT NULL CHECK (char_length(title) <= 200),
  change text NOT NULL CHECK (char_length(change) <= 300),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  requested_by uuid NOT NULL REFERENCES users (id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users (id),
  decided_at timestamptz,
  comment text CHECK (char_length(comment) <= 500),
  -- Why the last approval attempt failed (e.g. the pieces were packed since); the request stays pending.
  last_error text CHECK (char_length(last_error) <= 500),
  CONSTRAINT approval_requests_decided CHECK ((status = 'PENDING') = (decided_at IS NULL))
);
CREATE INDEX approval_requests_status_idx ON approval_requests (status, requested_at DESC);
-- One open request per reversal of a record.
CREATE UNIQUE INDEX approval_requests_open_idx ON approval_requests (type, target_id)
  WHERE status = 'PENDING' AND type NOT IN ('FABRIC_ADJUSTMENT', 'GODOWN_ADJUSTMENT');
