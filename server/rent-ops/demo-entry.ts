import { startRentOpsDemoServer } from "./demo-server";

if (process.env.NODE_ENV === "production") {
  throw new Error("Rent Operations demo entry is local-only and cannot run in production");
}

const server = startRentOpsDemoServer({ port: Number(process.env.PORT ?? 4175) });
const address = server.address();
const port = typeof address === "object" && address ? address.port : Number(process.env.PORT ?? 4175);
console.log(`Rent Operations demo server listening at http://127.0.0.1:${port}`);
