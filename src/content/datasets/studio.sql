-- Dataset "studio": an interactive branching-video SaaS (a small interactive-video platform).
-- Users own projects; projects contain clips that form a branching tree; render jobs
-- are processed by workers; credits are tracked in a ledger. Deterministic data.
CREATE TABLE users (
  id            integer PRIMARY KEY,
  email         text        NOT NULL UNIQUE,
  display_name  text        NOT NULL,
  plan          text        NOT NULL CHECK (plan IN ('free','pro','team')),
  created_at    timestamptz NOT NULL
);

CREATE TABLE projects (
  id          integer PRIMARY KEY,
  owner_id    integer     NOT NULL REFERENCES users(id),
  title       text        NOT NULL,
  doc         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  version     integer     NOT NULL DEFAULT 1,
  published   boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);

CREATE TABLE project_members (
  project_id  integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     integer NOT NULL REFERENCES users(id),
  role        text    NOT NULL CHECK (role IN ('editor','viewer')),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE clips (
  id              integer PRIMARY KEY,
  project_id      integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_clip_id  integer REFERENCES clips(id),
  title           text    NOT NULL,
  choice_label    text,
  duration_ms     integer NOT NULL CHECK (duration_ms > 0)
);

CREATE TABLE render_jobs (
  id           integer PRIMARY KEY,
  project_id   integer     NOT NULL REFERENCES projects(id),
  kind         text        NOT NULL CHECK (kind IN ('encode','thumbnail','transition')),
  status       text        NOT NULL CHECK (status IN ('queued','running','done','failed')),
  attempts     integer     NOT NULL DEFAULT 0,
  worker       text,
  created_at   timestamptz NOT NULL,
  started_at   timestamptz,
  finished_at  timestamptz
);

CREATE TABLE credit_ledger (
  id          integer PRIMARY KEY,
  user_id     integer     NOT NULL REFERENCES users(id),
  delta       integer     NOT NULL,
  reason      text        NOT NULL,
  created_at  timestamptz NOT NULL
);

INSERT INTO users (id, email, display_name, plan, created_at) VALUES
  (1, 'mara@studio.dev',  'Mara',  'team', '2025-01-02 09:00:00+00'),
  (2, 'jonas@studio.dev', 'Jonas', 'pro',  '2025-01-20 12:30:00+00'),
  (3, 'ivy@studio.dev',   'Ivy',   'free', '2025-02-11 08:15:00+00'),
  (4, 'omar@studio.dev',  'Omar',  'pro',  '2025-03-05 17:45:00+00'),
  (5, 'lena@studio.dev',  'Lena',  'free', '2025-04-18 10:10:00+00'),
  (6, 'kai@studio.dev',   'Kai',   'team', '2025-05-30 14:00:00+00');

INSERT INTO projects (id, owner_id, title, doc, version, published, created_at, updated_at) VALUES
  (1, 1, 'The Heist',            '{"aspect":"16:9","fps":30,"tags":["thriller","interactive"],"settings":{"autoplay":true}}', 14, true,  '2025-01-03 10:00:00+00', '2025-06-01 09:00:00+00'),
  (2, 1, 'Onboarding Tour',      '{"aspect":"9:16","fps":30,"tags":["product"],"settings":{"autoplay":false}}',             3,  false, '2025-02-10 11:00:00+00', '2025-02-12 15:00:00+00'),
  (3, 2, 'Choose Your Coffee',   '{"aspect":"1:1","fps":25,"tags":["ad","food"],"settings":{"autoplay":true}}',              7,  true,  '2025-02-01 08:00:00+00', '2025-05-20 18:30:00+00'),
  (4, 3, 'My First Story',       '{"aspect":"16:9","fps":24,"tags":[]}',                                                     1,  false, '2025-03-01 20:00:00+00', '2025-03-01 20:00:00+00'),
  (5, 4, 'Escape Room Teaser',   '{"aspect":"16:9","fps":60,"tags":["game","thriller"],"settings":{"autoplay":true}}',       22, true,  '2025-03-10 09:30:00+00', '2025-07-02 12:00:00+00'),
  (6, 6, 'Safety Training 2025', '{"aspect":"16:9","fps":30,"tags":["training"],"settings":{"autoplay":false}}',             9,  false, '2025-06-01 07:00:00+00', '2025-07-10 16:45:00+00');

INSERT INTO project_members (project_id, user_id, role) VALUES
  (1, 2, 'editor'), (1, 3, 'viewer'), (1, 6, 'editor'),
  (3, 4, 'viewer'),
  (5, 2, 'editor'), (5, 5, 'viewer'),
  (6, 1, 'editor'), (6, 5, 'viewer');

-- Project 1 "The Heist": a branching tree
--   1 Intro → 2 Front door | 3 Rooftop
--   2 → 4 Bribe guard | 5 Sneak past ;  3 → 6 Zipline ; 5 → 7 Vault (ending)
INSERT INTO clips (id, project_id, parent_clip_id, title, choice_label, duration_ms) VALUES
  (1,  1, NULL, 'Intro',            NULL,            12000),
  (2,  1, 1,    'Front door',       'Go in the front', 8000),
  (3,  1, 1,    'Rooftop',          'Climb the roof',  9500),
  (4,  1, 2,    'Bribe the guard',  'Bribe',           6000),
  (5,  1, 2,    'Sneak past',       'Sneak',           7000),
  (6,  1, 3,    'Zipline',          'Jump',            5500),
  (7,  1, 5,    'The vault',        'Open the vault',  15000),
  (8,  3, NULL, 'Welcome',          NULL,            4000),
  (9,  3, 8,    'Espresso',         'Strong',          3000),
  (10, 3, 8,    'Latte',            'Milky',           3500),
  (11, 3, 10,   'Oat milk',         'Oat',             2500),
  (12, 4, NULL, 'Hello world',      NULL,            10000),
  (13, 5, NULL, 'Wake up',          NULL,            9000),
  (14, 5, 13,   'Search the desk',  'Desk',            7000),
  (15, 5, 13,   'Try the door',     'Door',            4000),
  (16, 5, 14,   'Hidden key',       'Lift the lamp',   6500),
  (17, 6, NULL, 'Hazard intro',     NULL,            20000),
  (18, 6, 17,   'Correct answer',   'Wear gloves',     8000),
  (19, 6, 17,   'Wrong answer',     'Skip gloves',     8000);

INSERT INTO render_jobs (id, project_id, kind, status, attempts, worker, created_at, started_at, finished_at) VALUES
  (1,  1, 'encode',     'done',    1, 'worker-a', '2025-06-01 09:00:00+00', '2025-06-01 09:00:05+00', '2025-06-01 09:02:35+00'),
  (2,  1, 'thumbnail',  'done',    1, 'worker-b', '2025-06-01 09:00:00+00', '2025-06-01 09:00:03+00', '2025-06-01 09:00:09+00'),
  (3,  3, 'encode',     'done',    2, 'worker-a', '2025-05-20 18:30:00+00', '2025-05-20 18:31:00+00', '2025-05-20 18:33:00+00'),
  (4,  3, 'transition', 'failed',  3, 'worker-c', '2025-05-20 18:35:00+00', '2025-05-20 18:35:10+00', '2025-05-20 18:36:00+00'),
  (5,  5, 'encode',     'done',    1, 'worker-b', '2025-07-02 12:00:00+00', '2025-07-02 12:00:20+00', '2025-07-02 12:05:20+00'),
  (6,  5, 'transition', 'running', 1, 'worker-c', '2025-07-02 12:06:00+00', '2025-07-02 12:06:05+00', NULL),
  (7,  6, 'encode',     'queued',  0, NULL,       '2025-07-10 16:45:00+00', NULL, NULL),
  (8,  6, 'thumbnail',  'queued',  0, NULL,       '2025-07-10 16:45:01+00', NULL, NULL),
  (9,  2, 'encode',     'failed',  1, 'worker-a', '2025-02-12 15:00:00+00', '2025-02-12 15:00:30+00', '2025-02-12 15:01:00+00'),
  (10, 4, 'encode',     'queued',  0, NULL,       '2025-03-01 20:00:00+00', NULL, NULL),
  (11, 1, 'transition', 'done',    1, 'worker-c', '2025-06-01 09:03:00+00', '2025-06-01 09:03:02+00', '2025-06-01 09:04:12+00'),
  (12, 5, 'thumbnail',  'done',    1, 'worker-a', '2025-07-02 12:00:00+00', '2025-07-02 12:00:01+00', '2025-07-02 12:00:04+00');

INSERT INTO credit_ledger (id, user_id, delta, reason, created_at) VALUES
  (1,  1,  500, 'plan:team monthly',     '2025-06-01 00:00:00+00'),
  (2,  1,  -40, 'ai transition',         '2025-06-01 09:03:00+00'),
  (3,  1,  -10, 'publish',               '2025-06-01 09:05:00+00'),
  (4,  2,  200, 'plan:pro monthly',      '2025-05-01 00:00:00+00'),
  (5,  2,  -25, 'ai transition',         '2025-05-20 18:35:00+00'),
  (6,  2,   25, 'refund: failed job 4',  '2025-05-20 18:40:00+00'),
  (7,  2,  -10, 'publish',               '2025-05-20 18:45:00+00'),
  (8,  4,  200, 'plan:pro monthly',      '2025-07-01 00:00:00+00'),
  (9,  4,  -60, 'ai transition',         '2025-07-02 12:06:00+00'),
  (10, 4,  -10, 'publish',               '2025-07-02 12:10:00+00'),
  (11, 6,  500, 'plan:team monthly',     '2025-07-01 00:00:00+00'),
  (12, 3,   20, 'free starter credits',  '2025-02-11 08:15:00+00'),
  (13, 5,   20, 'free starter credits',  '2025-04-18 10:10:00+00'),
  (14, 5,   -5, 'thumbnail regenerate',  '2025-04-20 09:00:00+00');
