-- Lead follow-up DRIP campaign — S1 schema + seed.
-- Config-as-data message store (dashboard-editable) + runtime state tables. Single source of
-- truth for follow-up copy/cadence. The n8n sweep reads config each tick; edits take effect on
-- the next send. Idempotent: safe to re-run.
--
-- Design refs (session plan): cadence 4 touches day 1 then taper; stop conditions anchored on
-- Chatwoot (human response / label removed / conversation resolved) + delivery failure + max/expiry;
-- contact hours 08:00-20:00 America/Los_Angeles; category-specific copy with vertical-default fallback.

-- ================= CONFIG (dashboard-editable) =================

CREATE TABLE IF NOT EXISTS drip_sequence (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key                 TEXT UNIQUE NOT NULL,               -- stable id, e.g. 'lsa_landscaping'
  name                TEXT NOT NULL,
  source              TEXT NOT NULL,                      -- google_lsa | thumbtack | any
  vertical            TEXT,                               -- landscaping | tree | ...
  channel             TEXT NOT NULL DEFAULT 'sms',
  is_active           BOOLEAN NOT NULL DEFAULT FALSE,     -- seeded OFF; enabled after runtime is live
  max_messages        INT NOT NULL DEFAULT 7,
  expires_after_hours INT NOT NULL DEFAULT 168,           -- 7 days
  quiet_start_local   TIME NOT NULL DEFAULT '08:00',
  quiet_end_local     TIME NOT NULL DEFAULT '20:00',
  tz_default          TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  variant_strategy    TEXT NOT NULL DEFAULT 'random',     -- random | round_robin | weighted_ab
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS drip_step (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sequence_id    BIGINT NOT NULL REFERENCES drip_sequence(id) ON DELETE CASCADE,
  step_index     INT NOT NULL,                            -- 0 = initial, 1..n = follow-ups
  offset_minutes INT NOT NULL,                            -- elapsed from T0 (successful initial send)
  label          TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sequence_id, step_index)
);

CREATE TABLE IF NOT EXISTS drip_message (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  step_id        BIGINT NOT NULL REFERENCES drip_step(id) ON DELETE CASCADE,
  category_key   TEXT,                                    -- NULL = vertical default; else category override
  variant        TEXT NOT NULL DEFAULT 'A',
  body           TEXT NOT NULL,
  include_optout BOOLEAN NOT NULL DEFAULT FALSE,
  weight         INT NOT NULL DEFAULT 1,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  version        INT NOT NULL DEFAULT 1,
  updated_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (step_id, category_key, variant)
);

-- Edit history for versioning / revert / who-changed-what.
CREATE TABLE IF NOT EXISTS drip_message_history (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id  BIGINT NOT NULL REFERENCES drip_message(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  version     INT NOT NULL,
  changed_by  TEXT,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Canonical taxonomy: Thumbtack category name / Google LSA service slug -> category_key.
CREATE TABLE IF NOT EXISTS drip_category_map (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category_key TEXT NOT NULL,
  source       TEXT NOT NULL,                             -- thumbtack | google_lsa
  raw_value    TEXT NOT NULL,                             -- 'Tree Stump Grinding and Removal' | 'yard_cleanup'
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, raw_value)
);

-- ================= RUNTIME (system-owned) =================

CREATE TABLE IF NOT EXISTS drip_enrollment (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sequence_id          BIGINT REFERENCES drip_sequence(id),
  lead_ref             TEXT NOT NULL,                     -- stable lead/conversation id (dup guard)
  conversation_id      TEXT,
  source               TEXT,
  vertical             TEXT,
  channel              TEXT NOT NULL DEFAULT 'sms',
  phone_e164           TEXT NOT NULL,
  category_raw         TEXT,
  category_key         TEXT,
  time_zone            TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  step                 INT NOT NULL DEFAULT 0,
  t0_at                TIMESTAMPTZ NOT NULL,              -- successful initial send
  enrolled_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at      TIMESTAMPTZ,
  next_due_at          TIMESTAMPTZ,
  attempts             INT NOT NULL DEFAULT 0,
  max_messages         INT NOT NULL DEFAULT 7,
  expires_at           TIMESTAMPTZ NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active',    -- active | completed | exited
  response_status      TEXT NOT NULL DEFAULT 'none',
  exit_reason          TEXT,
  last_delivery_status TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (lead_ref)
);
CREATE INDEX IF NOT EXISTS idx_drip_enrollment_due ON drip_enrollment (status, next_due_at);

-- Permanent opt-out / do-not-contact. Highest precedence; blocks any future auto re-enrollment.
CREATE TABLE IF NOT EXISTS drip_suppression (
  phone_e164 TEXT PRIMARY KEY,
  reason     TEXT,
  source     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS drip_delivery_log (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  enrollment_id       BIGINT REFERENCES drip_enrollment(id) ON DELETE CASCADE,
  lead_ref            TEXT,
  step                INT,
  idem_key            TEXT UNIQUE,                        -- (lead_ref:step) -> idempotent send
  provider_message_id TEXT,
  status              TEXT,
  error_code          TEXT,
  sent_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ================= SEED (idempotent) =================
-- Two Google-LSA sequences (landscaping, tree), seeded is_active=FALSE. Approved cadence:
-- step 0 initial, then +30m, +2h, +5h (4 touches day 1), +1d, +3d, +6d final close-the-loop.

INSERT INTO drip_sequence (key, name, source, vertical, is_active, max_messages, expires_after_hours, variant_strategy)
VALUES
  ('lsa_landscaping', 'LSA Follow-up (Landscaping)', 'google_lsa', 'landscaping', FALSE, 7, 168, 'random'),
  ('lsa_tree',        'LSA Follow-up (Tree)',        'google_lsa', 'tree',        FALSE, 7, 168, 'random')
ON CONFLICT (key) DO NOTHING;

INSERT INTO drip_step (sequence_id, step_index, offset_minutes, label)
SELECT s.id, v.step_index, v.offset_minutes, v.label
FROM drip_sequence s
CROSS JOIN (VALUES
  (0, 0,    'initial'),
  (1, 30,   'F1 +30m'),
  (2, 120,  'F2 +2h'),
  (3, 300,  'F3 +5h'),
  (4, 1440, 'F4 +1d'),
  (5, 4320, 'F5 +3d'),
  (6, 8640, 'F6 final +6d')
) AS v(step_index, offset_minutes, label)
WHERE s.key IN ('lsa_landscaping', 'lsa_tree')
ON CONFLICT (sequence_id, step_index) DO NOTHING;

-- Default (category_key NULL) messages per step, per vertical. {name}/{service}/{Business} are
-- runtime placeholders. include_optout=TRUE where the body carries "Reply STOP".
INSERT INTO drip_message (step_id, category_key, variant, body, include_optout)
SELECT st.id, NULL, 'A', v.body, v.optout
FROM drip_step st
JOIN drip_sequence s ON s.id = st.sequence_id
JOIN (VALUES
  -- landscaping
  ('lsa_landscaping', 0, 'Hi {name}, thanks for reaching out to Washington Landscaping about {service}! Reply with a good time to call, or just "yes" and we''ll take it from there. If we don''t hear back we may check in a couple of times. Reply STOP to opt out.', TRUE),
  ('lsa_landscaping', 1, 'Hi {name}, just making sure this reached you. Want us to call about your {service}? Reply "yes," "no," or a good time.', FALSE),
  ('lsa_landscaping', 2, 'No rush at all, {name} — whenever you''re ready for your {service} quote, reply with a time that works and we''ll set it up.', FALSE),
  ('lsa_landscaping', 3, 'Hi {name}, still happy to help with {service}. Reply "yes" for a quick call, "later," or a day/time that suits you. Reply STOP to opt out.', TRUE),
  ('lsa_landscaping', 4, 'Morning {name}! If {service} is still on your list, reply "yes" and we''ll get you a quote. If now''s not the time, reply "later."', FALSE),
  ('lsa_landscaping', 5, 'Hi {name}, whenever the timing''s right for your {service}, we''re here. Reply with a good time and we''ll take care of the rest. Reply STOP to opt out.', TRUE),
  ('lsa_landscaping', 6, 'Hi {name}, we''ll close this out so we''re not filling your inbox. If you''d still like a {service} quote down the road, just reply anytime. Thanks from Washington Landscaping!', FALSE),
  -- tree
  ('lsa_tree', 0, 'Hi {name}, thanks for reaching out to Washington Tree Services about {service}! Reply with a good time to call, or just "yes" and we''ll take it from there. If we don''t hear back we may check in a couple of times. Reply STOP to opt out.', TRUE),
  ('lsa_tree', 1, 'Hi {name}, just making sure this reached you. Want us to call about your {service}? Reply "yes," "no," or a good time.', FALSE),
  ('lsa_tree', 2, 'No rush at all, {name} — whenever you''re ready for your {service} quote, reply with a time that works and we''ll set it up.', FALSE),
  ('lsa_tree', 3, 'Hi {name}, still happy to help with {service}. Reply "yes" for a quick call, "later," or a day/time that suits you. Reply STOP to opt out.', TRUE),
  ('lsa_tree', 4, 'Morning {name}! If {service} is still on your list, reply "yes" and we''ll get you a quote. If now''s not the time, reply "later."', FALSE),
  ('lsa_tree', 5, 'Hi {name}, whenever the timing''s right for your {service}, we''re here. Reply with a good time and we''ll take care of the rest. Reply STOP to opt out.', TRUE),
  ('lsa_tree', 6, 'Hi {name}, we''ll close this out so we''re not filling your inbox. If you''d still like a {service} quote down the road, just reply anytime. Thanks from Washington Tree Services!', FALSE)
) AS v(seq_key, step_index, body, optout) ON v.seq_key = s.key AND v.step_index = st.step_index
ON CONFLICT (step_id, category_key, variant) DO NOTHING;

-- Category override example: stump grinding (tree, step 1) references the service specifically.
INSERT INTO drip_message (step_id, category_key, variant, body, include_optout)
SELECT st.id, 'stump_grinding', 'A',
  'Hi {name}, following up on your stump grinding request. Our pricing is straightforward — $175 for the first linear foot and $105 for each additional foot, and we handle the required utility locate. Reply "yes" and we''ll get you scheduled, or a good time to call.',
  FALSE
FROM drip_step st
JOIN drip_sequence s ON s.id = st.sequence_id
WHERE s.key = 'lsa_tree' AND st.step_index = 1
ON CONFLICT (step_id, category_key, variant) DO NOTHING;

-- Canonical taxonomy (from categories seen in Chatwoot history).
INSERT INTO drip_category_map (category_key, source, raw_value)
VALUES
  ('stump_grinding',   'thumbtack',  'Tree Stump Grinding and Removal'),
  ('tree_trimming',    'thumbtack',  'Tree Trimming and Removal'),
  ('tree_trimming',    'thumbtack',  'Shrub Trimming and Removal'),
  ('artificial_turf',  'thumbtack',  'Artificial Turf Installation'),
  ('land_clearing',    'thumbtack',  'Land Clearing'),
  ('grading',          'thumbtack',  'Land Leveling and Grading'),
  ('sod',              'thumbtack',  'Sod Installation'),
  ('lawn_care',        'thumbtack',  'Lawn Mowing and Trimming'),
  ('grading',          'google_lsa', 'grading_resloping'),
  ('land_clearing',    'google_lsa', 'yard_cleanup'),
  ('paving',           'google_lsa', 'paving_driveway_walkway'),
  ('garden_decor',     'google_lsa', 'garden_decorations')
ON CONFLICT (source, raw_value) DO NOTHING;
