-- Dataset "shop": a small online shop. Deterministic (no now()/random()).
CREATE TABLE customers (
  id          integer PRIMARY KEY,
  name        text        NOT NULL,
  email       text        NOT NULL UNIQUE,
  country     text        NOT NULL,
  city        text,
  created_at  date        NOT NULL
);

CREATE TABLE categories (
  id    integer PRIMARY KEY,
  name  text NOT NULL UNIQUE
);

CREATE TABLE products (
  id           integer PRIMARY KEY,
  name         text           NOT NULL,
  category_id  integer        NOT NULL REFERENCES categories(id),
  price        numeric(10,2)  NOT NULL CHECK (price >= 0),
  stock        integer        NOT NULL DEFAULT 0,
  active       boolean        NOT NULL DEFAULT true
);

CREATE TABLE orders (
  id           integer PRIMARY KEY,
  customer_id  integer   NOT NULL REFERENCES customers(id),
  status       text      NOT NULL CHECK (status IN ('pending','paid','shipped','cancelled')),
  ordered_at   timestamp NOT NULL
);

CREATE TABLE order_items (
  order_id    integer       NOT NULL REFERENCES orders(id),
  product_id  integer       NOT NULL REFERENCES products(id),
  quantity    integer       NOT NULL CHECK (quantity > 0),
  unit_price  numeric(10,2) NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

CREATE TABLE employees (
  id          integer PRIMARY KEY,
  name        text    NOT NULL,
  title       text    NOT NULL,
  manager_id  integer REFERENCES employees(id),
  salary      integer NOT NULL,
  hired_at    date    NOT NULL
);

INSERT INTO customers (id, name, email, country, city, created_at) VALUES
  (1,  'Ada Lovelace',     'ada@example.com',     'UK',      'London',    '2024-01-15'),
  (2,  'Linus Torvalds',   'linus@example.com',   'Finland', 'Helsinki',  '2024-02-03'),
  (3,  'Grace Hopper',     'grace@example.com',   'USA',     'New York',  '2024-02-20'),
  (4,  'Margaret Hamilton','margaret@example.com','USA',     'Boston',    '2024-03-11'),
  (5,  'Anders Hejlsberg', 'anders@example.com',  'Denmark', 'Copenhagen','2024-04-01'),
  (6,  'Barbara Liskov',   'barbara@example.com', 'USA',     'Boston',    '2024-05-09'),
  (7,  'Klaus Wirth',      'klaus@example.com',   'Germany', 'Berlin',    '2024-06-17'),
  (8,  'Sophie Wilson',    'sophie@example.com',  'UK',      'Cambridge', '2024-07-22'),
  (9,  'Mia Schneider',    'mia@example.com',     'Germany', 'Munich',    '2024-09-05'),
  (10, 'Noah Becker',      'noah@example.com',    'Germany', NULL,        '2024-11-30');

INSERT INTO categories (id, name) VALUES
  (1, 'Keyboards'), (2, 'Mice'), (3, 'Monitors'), (4, 'Books'), (5, 'Accessories');

INSERT INTO products (id, name, category_id, price, stock, active) VALUES
  (1,  'Mechanical Keyboard',  1, 89.90,  25, true),
  (2,  'Low-profile Keyboard', 1, 59.00,  40, true),
  (3,  'Wireless Mouse',       2, 29.99,  80, true),
  (4,  'Gaming Mouse',         2, 49.50,  15, true),
  (5,  '27" 4K Monitor',       3, 329.00, 8,  true),
  (6,  '24" Monitor',          3, 149.00, 0,  true),
  (7,  'Clean Code',           4, 32.00,  30, true),
  (8,  'Designing Data-Intensive Applications', 4, 45.00, 22, true),
  (9,  'The Pragmatic Programmer', 4, 38.50, 0, false),
  (10, 'USB-C Hub',            5, 24.90,  60, true),
  (11, 'Laptop Stand',         5, 19.99,  35, true),
  (12, 'Desk Mat',             5, 14.50,  100, true);

INSERT INTO orders (id, customer_id, status, ordered_at) VALUES
  (1,  1, 'shipped',   '2025-01-05 10:12:00'),
  (2,  2, 'shipped',   '2025-01-09 14:30:00'),
  (3,  1, 'paid',      '2025-02-01 09:00:00'),
  (4,  3, 'shipped',   '2025-02-14 18:45:00'),
  (5,  4, 'cancelled', '2025-02-20 11:11:00'),
  (6,  5, 'shipped',   '2025-03-03 08:20:00'),
  (7,  3, 'paid',      '2025-03-15 16:05:00'),
  (8,  6, 'pending',   '2025-03-28 12:00:00'),
  (9,  7, 'shipped',   '2025-04-02 19:30:00'),
  (10, 2, 'paid',      '2025-04-10 07:55:00'),
  (11, 8, 'shipped',   '2025-04-21 13:40:00'),
  (12, 9, 'pending',   '2025-05-01 10:00:00'),
  (13, 1, 'shipped',   '2025-05-12 15:15:00'),
  (14, 3, 'cancelled', '2025-05-20 09:30:00'),
  (15, 5, 'paid',      '2025-06-02 17:00:00'),
  (16, 9, 'shipped',   '2025-06-15 11:45:00'),
  (17, 4, 'shipped',   '2025-06-30 20:10:00'),
  (18, 7, 'pending',   '2025-07-04 09:05:00');

INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES
  (1, 1, 1, 89.90), (1, 3, 1, 29.99),
  (2, 5, 1, 329.00), (2, 10, 2, 24.90),
  (3, 7, 1, 32.00), (3, 8, 1, 45.00),
  (4, 2, 1, 59.00), (4, 12, 1, 14.50),
  (5, 6, 1, 149.00),
  (6, 1, 2, 89.90), (6, 4, 1, 49.50),
  (7, 8, 2, 45.00),
  (8, 11, 1, 19.99), (8, 12, 2, 14.50),
  (9, 5, 2, 329.00),
  (10, 3, 3, 29.99), (10, 10, 1, 24.90),
  (11, 7, 1, 32.00), (11, 9, 1, 38.50),
  (12, 2, 1, 59.00),
  (13, 10, 1, 24.90), (13, 11, 1, 19.99), (13, 12, 1, 14.50),
  (14, 4, 1, 49.50),
  (15, 1, 1, 85.00), (15, 8, 1, 45.00),
  (16, 3, 2, 29.99),
  (17, 5, 1, 319.00), (17, 2, 1, 59.00),
  (18, 12, 4, 14.50);

INSERT INTO employees (id, name, title, manager_id, salary, hired_at) VALUES
  (1, 'Erin Ceo',       'CEO',                NULL, 180000, '2019-03-01'),
  (2, 'Tom Tech',       'CTO',                1,    160000, '2019-06-15'),
  (3, 'Sara Sales',     'Head of Sales',      1,    120000, '2020-01-10'),
  (4, 'Ben Backend',    'Senior Engineer',    2,    95000,  '2020-09-01'),
  (5, 'Fiona Frontend', 'Senior Engineer',    2,    93000,  '2021-02-14'),
  (6, 'Jan Junior',     'Engineer',           4,    62000,  '2023-08-01'),
  (7, 'Lea Lead',       'Account Executive',  3,    70000,  '2022-04-04'),
  (8, 'Max Intern',     'Intern',             5,    30000,  '2025-03-01');
