# Backend Async Challenge (NestJS + MongoDB + RabbitMQ)

This repository implements an async backend exercise focused on:

- communication between backend services
- eventual consistency
- idempotent consumers
- duplicate event handling
- stock reservation and release flows

It includes:

- `order-service` (NestJS)
- `inventory-service` (NestJS)
- `rabbitmq`
- `mongodb-order`
- `mongodb-inventory`
- `docker-compose.yml`

## Architecture

### order-service

Responsible for:

- creating orders
- storing order state
- publishing `OrderCreated` and `OrderCancelled`
- consuming `InventoryReserved` and `InventoryRejected`

### inventory-service

Responsible for:

- managing stock
- consuming `OrderCreated` and `OrderCancelled`
- reserving / releasing stock
- publishing `InventoryReserved` and `InventoryRejected`

### Messaging

RabbitMQ is used for async service communication.

Suggested event flow:

1. `POST /orders` creates an order with `PENDING`
2. order-service publishes `OrderCreated`
3. inventory-service consumes it and tries to reserve stock
4. inventory-service publishes `InventoryReserved` or `InventoryRejected`
5. order-service consumes result and updates order state

## Current Implementation Status

Implemented:

- end-to-end async order/inventory flow with RabbitMQ topic routing
- Mongo-backed order state transitions (`PENDING`, `CONFIRMED`, `REJECTED`, `CANCELLED`)
- transactional inventory reserve/release logic
- duplicate-handling via reservation record uniqueness by `orderId`
- poison message protection for malformed JSON and invalid event payloads (non-retryable failures are not requeued)
- unit and integration-style tests (without in-memory Mongo server)

Known limitation:

- no full CI e2e test booting both services + real RabbitMQ + real Mongo together

## Event Routing Keys

- `orders.created` -> `{ payload: { orderId, customerId, items[] } }`
- `orders.cancelled` -> `{ payload: { orderId } }`
- `inventory.reserved` -> `{ payload: { orderId } }`
- `inventory.rejected` -> `{ payload: { orderId, reason } }`

## Message Failure Policy

- Messages are `ack`ed only after successful handler execution.
- Transient/runtime processing failures are `nack`ed with requeue (`requeue=true`) for retry.
- Malformed JSON payloads (`SyntaxError`) are treated as non-retryable and are `nack`ed without requeue (`requeue=false`).
- Invalid event payloads detected by consumer validation (`NonRetryableMessageError`) are `nack`ed without requeue (`requeue=false`).

## Validation Rules (API)

- order item `quantity` must be `>= 1`
- stock upsert `available` must be an integer `>= 0`
- DTO validation runs globally in both services

## Prerequisites

- Docker Desktop
- Node.js 20.x (recommended 20.19+)
- npm 10+

## Local Run

```bash
docker compose up --build
```

Services:

- order-service: `http://localhost:3001`
- inventory-service: `http://localhost:3002`
- RabbitMQ UI: `http://localhost:15672`
  - username: `guest`
  - password: `guest`

## Service Checks

Order service:

```bash
cd order-service
npm install
npm run lint
npm run typecheck
npm test
```

Inventory service:

```bash
cd inventory-service
npm install
npm run lint
npm run typecheck
npm test
```

## Quick Manual Flow

1. Seed stock:

```http
POST http://localhost:3002/inventory/stock
Content-Type: application/json

{
  "sku": "SKU-1",
  "available": 10
}
```

2. Create order:

```http
POST http://localhost:3001/orders
Content-Type: application/json

{
  "customerId": "cust-1",
  "items": [
    { "sku": "SKU-1", "quantity": 2 }
  ]
}
```

3. Read order until final status:

```http
GET http://localhost:3001/orders/{orderId}
```

4. Cancel order:

```http
POST http://localhost:3001/orders/{orderId}/cancel
```

5. Verify stock release:

```http
GET http://localhost:3002/inventory/SKU-1
```

