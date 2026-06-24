import bcrypt from "bcryptjs";
import db from "./database.js";

/**
 * Seeds the database with a demo admin/dispatcher and a few drivers.
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

  // Admin / dispatcher
  upsertUser({
    name: "Administrador",
    email: "admin@agencia.com",
    password: hash("admin123"),
    role: "admin",
  });

  // Drivers
  const drivers = [
    { name: "Juan Pérez", email: "juan@agencia.com", phone: "300 111 2233", vehicle: "Moto", plate: "ABC12D" },
    { name: "María Gómez", email: "maria@agencia.com", phone: "300 222 3344", vehicle: "Moto", plate: "XYZ98E" },
    { name: "Carlos Ruiz", email: "carlos@agencia.com", phone: "300 333 4455", vehicle: "Bicicleta", plate: "—" },
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

  // A couple of demo orders (pending, unassigned) around Bogotá.
  const orderCount = db.prepare("SELECT COUNT(*) AS c FROM orders").get().c;
  if (orderCount === 0) {
    db.prepare(
      `INSERT INTO orders (code, customer_name, customer_phone, pickup_address, pickup_lat, pickup_lng,
                          dropoff_address, dropoff_lat, dropoff_lng, items, amount, payment_method, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    ).run(
      "ORD-1001", "Laura Martínez", "311 555 7788",
      "Restaurante El Sabor, Cra 7 #45-12", 4.6285, -74.0646,
      "Calle 53 #10-20, Apto 302", 4.6431, -74.0628,
      "1 almuerzo ejecutivo, 1 jugo natural", 28000, "cash"
    );

    db.prepare(
      `INSERT INTO orders (code, customer_name, customer_phone, pickup_address, pickup_lat, pickup_lng,
                          dropoff_address, dropoff_lat, dropoff_lng, items, amount, payment_method, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    ).run(
      "ORD-1002", "Andrés Torres", "312 444 9900",
      "Farmacia Central, Av. 19 #120-30", 4.6951, -74.0360,
      "Calle 134 #15-40", 4.7110, -74.0410,
      "Medicamentos (1 bolsa)", 15000, "card"
    );
  }

  console.log("Seed completado.");
  console.log("  Admin:      admin@agencia.com  / admin123");
  console.log("  Repartidor: juan@agencia.com   / driver123");
  console.log("  Repartidor: maria@agencia.com  / driver123");
  console.log("  Repartidor: carlos@agencia.com / driver123");
}

seed();

// Force exit since the database wrapper keeps a timer alive
setTimeout(() => process.exit(0), 500);
