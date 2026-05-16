# Convex Backend Plugin

Builds modern, reactive, type-safe, production-grade backends on Convex that avoid generic AI architecture slop.

The backend design will be scalable and suitable for web apps with React, mobile apps with Expo, or any other front end architecture.

## What It Does

Claude automatically uses this skill for backend work on Convex. Produces correct, scalable server code with:

- Reactive queries that update in real time over WebSockets
- Server-mediated data access via queries, mutations, and actions
- Schema-first, end-to-end type safety from `defineSchema` to client
- ACID transactions and server-side composition inside mutations
- Agent-friendly function contracts with `v.*` validators

Promotes Convex best-practices to help avoid common and less well-known pitfalls that apps hit as they scale up.

## Usage

```
"Build a real-time chat backend with channels and messages"
"Build a mobile app that connects language learners across the globe."
"Create a task queue with scheduled processing"
"Design a data model for a multi-tenant SaaS app"
"Add user authentication and role-based access control"
"Build an API for an AI agent to manage calendar events"
```

Claude will choose the right Convex primitives (queries, mutations, actions, scheduler, components), define schemas with indexes, and implement server functions that are correct, composable, and production-ready.

## Author

Seth Raphael (seth@convex.dev)
