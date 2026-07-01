import bcrypt from "bcryptjs";
import db from "./database.js";
import { formatColombianPhone } from "../src/utils.js";

/**
 * Seeds the database with demo users: admin, drivers, and restaurants.
 * Safe to run multiple times: it skips users that already exist.
 */
function seed() {
  const hash = (pwd) => bcrypt.hashSync(pwd, 10);

  function upsertUser({ name, email, password, role }) {
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (existing) return;
    db.prepare("INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)")
      .run(name, email, password, role);
  }

  function getUserByEmail(email) {
    return db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  }

  function upsertDriver({ user_id, phone, vehicle, plate }) {
    const existing = db.prepare("SELECT user_id FROM drivers WHERE user_id = ?").get(user_id);
    if (existing) return;
    db.prepare("INSERT INTO drivers (user_id, phone, vehicle, plate, status) VALUES (?, ?, ?, ?, 'offline')")
      .run(user_id, phone, vehicle, plate);
  }

  function upsertRestaurant({ user_id, phone, address, lat, lng, category, description }) {
    const existing = db.prepare("SELECT user_id FROM restaurants WHERE user_id = ?").get(user_id);
    if (existing) return;
    db.prepare("INSERT INTO restaurants (user_id, phone, address, lat, lng, category, description) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(user_id, phone, address, lat, lng, category, description);
  }

  // ─── Admin / dispatcher ────────────────────────────────────────────────────
  upsertUser({
    name: "Administrador",
    email: "admin@agencia.com",
    password: hash("admin123"),
    role: "admin",
  });

  // ─── Drivers ───────────────────────────────────────────────────────────────
  const drivers = [
    { name: "Juan Pérez", email: "juan@agencia.com", phone: formatColombianPhone("300 111 2233"), vehicle: "Moto", plate: "ABC12D" },
    { name: "María Gómez", email: "maria@agencia.com", phone: formatColombianPhone("300 222 3344"), vehicle: "Moto", plate: "XYZ98E" },
    { name: "Carlos Ruiz", email: "carlos@agencia.com", phone: formatColombianPhone("300 333 4455"), vehicle: "Bicicleta", plate: "—" },
  ];

  for (const d of drivers) {
    upsertUser({
      name: d.name,
      email: d.email,
      password: hash("driver123"),
      role: "driver",
    });
    const user = getUserByEmail(d.email);
    if (user) {
      upsertDriver({
        user_id: user.id,
        phone: d.phone,
        vehicle: d.vehicle,
        plate: d.plate,
      });
    }
  }

  // ─── Restaurants ───────────────────────────────────────────────────────────
  const restaurants = [
    {
      name: "Restaurante El Sabor",
      email: "elsabor@agencia.com",
      phone: formatColombianPhone("601 234 5678"),
      address: "Cra 7 #45-12, Bogotá",
      lat: 4.6285,
      lng: -74.0646,
      category: "comida_colombiana",
      description: "Almuerzos ejecutivos y comida casera colombiana",
    },
    {
      name: "Pizzería Napoli",
      email: "napoli@agencia.com",
      phone: formatColombianPhone("300 987 6543"),
      address: "Av. 19 #98-10, Bogotá",
      lat: 4.6820,
      lng: -74.0520,
      category: "pizzeria",
      description: "Pizzas artesanales y pastas italianas",
    },
    {
      name: "Sushi Express",
      email: "sushi@agencia.com",
      phone: formatColombianPhone("310 555 1234"),
      address: "Calle 85 #15-30, Bogotá",
      lat: 4.6750,
      lng: -74.0480,
      category: "japonesa",
      description: "Sushi fresco, rolls y ramen",
    },
  ];

  for (const r of restaurants) {
    upsertUser({
      name: r.name,
      email: r.email,
      password: hash("rest123"),
      role: "restaurant",
    });
    const user = getUserByEmail(r.email);
    if (user) {
      upsertRestaurant({
        user_id: user.id,
        phone: r.phone,
        address: r.address,
        lat: r.lat,
        lng: r.lng,
        category: r.category,
        description: r.description,
      });
    }
  }

  // ─── Demo orders ───────────────────────────────────────────────────────────
  const orderCount = db.prepare("SELECT COUNT(*) AS c FROM orders").get().c;
  if (orderCount === 0) {
    // Get restaurant IDs for linking orders
    const elSabor = getUserByEmail("elsabor@agencia.com");
    const napoli = getUserByEmail("napoli@agencia.com");

    db.prepare(
      `INSERT INTO orders (code, customer_name, customer_phone, pickup_address, pickup_lat, pickup_lng,
                          dropoff_address, dropoff_lat, dropoff_lng, items, amount, payment_method, status, restaurant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(
      "ORD-1001", "Laura Martínez", formatColombianPhone("311 555 7788"),
      "Restaurante El Sabor, Cra 7 #45-12", 4.6285, -74.0646,
      "Calle 53 #10-20, Apto 302", 4.6431, -74.0628,
      "1 almuerzo ejecutivo, 1 jugo natural", 28000, "cash",
      elSabor ? elSabor.id : null
    );

    db.prepare(
      `INSERT INTO orders (code, customer_name, customer_phone, pickup_address, pickup_lat, pickup_lng,
                          dropoff_address, dropoff_lat, dropoff_lng, items, amount, payment_method, status, restaurant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(
      "ORD-1002", "Andrés Torres", formatColombianPhone("312 444 9900"),
      "Pizzería Napoli, Av. 19 #98-10", 4.6820, -74.0520,
      "Calle 134 #15-40", 4.7110, -74.0410,
      "1 Pizza Margarita grande, 1 Coca-Cola", 42000, "card",
      napoli ? napoli.id : null
    );
  }

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Seed completado. Usuarios de prueba:");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Admin:       admin@agencia.com    / admin123");
  console.log("  Repartidor:  juan@agencia.com     / driver123");
  console.log("  Repartidor:  maria@agencia.com    / driver123");
  console.log("  Repartidor:  carlos@agencia.com   / driver123");
  console.log("  Restaurante: elsabor@agencia.com  / rest123");
  console.log("  Restaurante: napoli@agencia.com   / rest123");
  console.log("  Restaurante: sushi@agencia.com    / rest123");
  console.log("═══════════════════════════════════════════════════════════════");
}

seed();

// Force exit since the database wrapper keeps a timer alive
setTimeout(() => process.exit(0), 500);
