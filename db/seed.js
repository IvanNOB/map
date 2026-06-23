import bcrypt from "bcryptjs";
import db from "./database.js";

/**
 * Seeds the database with a demo admin/dispatcher and a few drivers.
 * Safe to run multiple times: it skips users that already exist.
 */
function seed() {
  const hash = (pwd) => bcrypt.hashSync(pwd, 10);

  const upsertUser = db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES (@name, @email, @password, @role)
    ON CONFLICT(email) DO NOTHING
  `);
  const getUserByEmail = db.prepare(`SELECT * FROM users WHERE email = ?`);
  const upsertDriver = db.prepare(`
    INSERT INTO drivers (user_id, phone, vehicle, plate, status)
    VALUES (@user_id, @phone, @vehicle, @plate, 'offline')
    ON CONFLICT(user_id) DO NOTHING
  `);

  // Admin / dispatcher
  upsertUser.run({
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
    upsertUser.run({
      name: d.name,
      email: d.email,
      password: hash("driver123"),
      role: "driver",
    });
    const user = getUserByEmail.get(d.email);
    upsertDriver.run({
      user_id: user.id,
      phone: d.phone,
      vehicle: d.vehicle,
      plate: d.plate,
    });
  }

  // A couple of demo orders (pending, unassigned) around Bogotá.
  const orderCount = db.prepare(`SELECT COUNT(*) AS c FROM orders`).get().c;
  if (orderCount === 0) {
    const insertOrder = db.prepare(`
      INSERT INTO orders (code, customer_name, customer_phone, pickup_address, pickup_lat, pickup_lng,
                          dropoff_address, dropoff_lat, dropoff_lng, items, amount, payment_method, status)
      VALUES (@code, @customer_name, @customer_phone, @pickup_address, @pickup_lat, @pickup_lng,
              @dropoff_address, @dropoff_lat, @dropoff_lng, @items, @amount, @payment_method, 'pending')
    `);
    insertOrder.run({
      code: "ORD-1001",
      customer_name: "Laura Martínez",
      customer_phone: "311 555 7788",
      pickup_address: "Restaurante El Sabor, Cra 7 #45-12",
      pickup_lat: 4.6285, pickup_lng: -74.0646,
      dropoff_address: "Calle 53 #10-20, Apto 302",
      dropoff_lat: 4.6431, dropoff_lng: -74.0628,
      items: "1 almuerzo ejecutivo, 1 jugo natural",
      amount: 28000, payment_method: "cash",
    });
    insertOrder.run({
      code: "ORD-1002",
      customer_name: "Andrés Torres",
      customer_phone: "312 444 9900",
      pickup_address: "Farmacia Central, Av. 19 #120-30",
      pickup_lat: 4.6951, pickup_lng: -74.0360,
      dropoff_address: "Calle 134 #15-40",
      dropoff_lat: 4.7110, dropoff_lng: -74.0410,
      items: "Medicamentos (1 bolsa)",
      amount: 15000, payment_method: "card",
    });
  }

  console.log("Seed completado.");
  console.log("  Admin:      admin@agencia.com  / admin123");
  console.log("  Repartidor: juan@agencia.com   / driver123");
  console.log("  Repartidor: maria@agencia.com  / driver123");
  console.log("  Repartidor: carlos@agencia.com / driver123");
}

seed();
