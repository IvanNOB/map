import bcrypt from "bcryptjs";
import db, { init } from "./database.js";

/**
 * Seeds the database with a demo admin and a few drivers.
 * Idempotent: skips users/drivers/orders that already exist, so it is safe
 * to run on every deploy WITHOUT wiping real data.
 */
async function seed() {
  await init();

  const hash = (pwd) => bcrypt.hashSync(pwd, 10);

  async function upsertUser({ name, email, password, role }) {
    const existing = await db.get("SELECT id FROM users WHERE email = ?", [email]);
    if (existing) return;
    await db.run("INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)", [
      name,
      email,
      password,
      role,
    ]);
  }

  async function getUserByEmail(email) {
    return db.get("SELECT * FROM users WHERE email = ?", [email]);
  }

  async function upsertDriver({ user_id, phone, vehicle, plate }) {
    const existing = await db.get("SELECT user_id FROM drivers WHERE user_id = ?", [user_id]);
    if (existing) return;
    await db.run(
      "INSERT INTO drivers (user_id, phone, vehicle, plate, status) VALUES (?, ?, ?, ?, 'offline')",
      [user_id, phone, vehicle, plate]
    );
  }

  // Admin / dispatcher
  await upsertUser({
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
    await upsertUser({
      name: d.name,
      email: d.email,
      password: hash("driver123"),
      role: "driver",
    });
    const user = await getUserByEmail(d.email);
    if (user) {
      await upsertDriver({
        user_id: user.id,
        phone: d.phone,
        vehicle: d.vehicle,
        plate: d.plate,
      });
    }
  }

  // Demo orders (only if the orders table is empty).
  const { c } = await db.get("SELECT COUNT(*) AS c FROM orders");
  if (Number(c) === 0) {
    await db.run(
      `INSERT INTO orders (code, customer_name, customer_phone, pickup_address, pickup_lat, pickup_lng,
                          dropoff_address, dropoff_lat, dropoff_lng, items, amount, payment_method, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        "ORD-1001", "Laura Martínez", "311 555 7788",
        "Restaurante El Sabor, Cra 7 #45-12", 4.6285, -74.0646,
        "Calle 53 #10-20, Apto 302", 4.6431, -74.0628,
        "1 almuerzo ejecutivo, 1 jugo natural", 28000, "cash",
      ]
    );

    await db.run(
      `INSERT INTO orders (code, customer_name, customer_phone, pickup_address, pickup_lat, pickup_lng,
                          dropoff_address, dropoff_lat, dropoff_lng, items, amount, payment_method, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        "ORD-1002", "Andrés Torres", "312 444 9900",
        "Farmacia Central, Av. 19 #120-30", 4.6951, -74.0360,
        "Calle 134 #15-40", 4.7110, -74.0410,
        "Medicamentos (1 bolsa)", 15000, "card",
      ]
    );
  }

  console.log("Seed completado.");
  console.log("  Admin:      admin@agencia.com  / admin123");
  console.log("  Repartidor: juan@agencia.com   / driver123");
  console.log("  Repartidor: maria@agencia.com  / driver123");
  console.log("  Repartidor: carlos@agencia.com / driver123");

  await db.end();
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Error en seed:", err);
    process.exit(1);
  });
