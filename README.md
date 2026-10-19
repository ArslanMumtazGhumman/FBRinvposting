# DukaanOS

DukaanOS is a simple, touch-first shop management app for small businesses. The project now contains the responsive Angular shop interface and a NestJS/PostgreSQL authentication and multi-tenant foundation.

## Run locally

Start PostgreSQL (Docker Desktop must be running; the default local host port is `5433` to avoid colliding with an existing PostgreSQL service):

```bash
cd backend
copy .env.example .env
docker compose up -d
npm install
npx prisma migrate dev
npm run start:dev
```

Change `JWT_SECRET` in `backend/.env` to a random value of at least 32 characters before starting the API. The provided database credentials are for local development only.

In a second terminal, from the project root:

```bash
npm install
npm start
```

Open `http://localhost:4200/`, register a user and business, or sign in. The API listens at `http://127.0.0.1:3000` for the Angular client. The explicit IPv4 address avoids ambiguity if another local application binds `localhost:3000` over IPv6.

## Build

```bash
npm run build
```

Production files are written to `dist/dukaan-os/`.

Build and test the API from `backend/`:

```bash
npm run build
npm test
```

To apply production migrations, use `npx prisma migrate deploy` from `backend/`.

The current Prisma 6.19 dependency tree reports four high-severity advisories in Prisma's config/merge dependency chain. The automated fix offered by npm downgrades the Prisma CLI outside the pinned client/CLI pair; review and resolve this before production rather than applying `npm audit fix --force`.

## Current scope

- Standalone Angular 22 application with responsive desktop and mobile navigation.
- Home dashboard with daily overview, quick actions, inventory and money summaries, and attention items, retained behind authentication.
- Sales overview, product search and category filters, quantity-adjustable cart, and sale details.
- Cash, bank, JazzCash, credit, and partial payment flows, with quick customer selection and lightweight customer creation.
- NestJS REST API with PostgreSQL/Prisma user, business, and membership foundation.
- JWT registration/login, bcrypt password hashing, authenticated current-user lookup, business context, and OWNER/ADMIN/STAFF authorization.
- Business-scoped category and product APIs, opening stock, and a stock-movement ledger for restocks, adjustments, and damaged stock.
- The existing Stock screen reads and records products, categories, and stock movements through the API. Sales reads the same catalog; sale/customer records remain frontend-only until the Sales integration milestone.
- Products and categories are tenant-scoped; inventory quantities are positive decimal ledger entries whose movement type determines stock direction. Use `GET/POST/PATCH/DELETE /categories`, `GET/POST/PATCH/DELETE /products`, `POST /products/:id/stock/adjust`, and `GET /products/:id/stock-history`. Stock cannot become negative; archived products retain their ledger history.
- Sales/customer browser data is stored separately for each authenticated business; product and stock data are persisted in PostgreSQL.
- Web app manifest and app icon included as a foundation for future PWA support.
- Authentication tokens are kept in browser localStorage for refresh persistence. Use HTTPS in production and consider moving to secure HttpOnly cookies when deployment architecture is established.
