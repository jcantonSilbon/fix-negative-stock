# fix-negative-stock

Servicio Node.js que **corrige stocks negativos en Shopify**.  
Escucha o consulta las variantes con cantidad (`available`) menor que 0 y las ajusta automáticamente a 0 usando la **Admin API REST**.

---

## ⚙️ Función principal

- Detecta variantes con `available < 0` en Shopify.  
- Ajusta el valor a `0` con una llamada `POST /admin/api/{version}/inventory_levels/set.json`.  
- Evita errores en sincronización con Markets u otras integraciones.  
- Incluye endpoint `/variant-dry` para simular el comportamiento sin modificar datos (modo test).  
- Endpoint `/health` para monitorización desde Render o cron jobs.

---

## 🌐 Endpoints

| Ruta              | Descripción                                       |
|-------------------|---------------------------------------------------|
| `/health`         | Devuelve `{ ok: true }` para comprobar que corre. |
| `/variant-dry`    | Escaneo sin tocar datos, devuelve variantes con stock negativo. |
| `/fix` (opcional) | Corrige los negativos reales.                     |

---

## 🧩 Variables de entorno

Ejemplo `.env`:

```bash
SHOPIFY_DOMAIN=silbonshop.com
SHOPIFY_ADMIN_TOKEN=shpat_xxxxxxxxxxxxxxx
API_VERSION=2025-07

# Opcional
PORT=3000




Autor: Javier García-Rojo Cantón — Lead Developer, Silbon
