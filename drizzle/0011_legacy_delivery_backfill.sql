WITH unrepresented_legacy_order AS (
  SELECT o.id AS order_id
    FROM orders o
   WHERE o.stock_mode = 'LegacyConsumed'
     AND EXISTS (
       SELECT 1 FROM deliveries d
        WHERE d.order_id = o.id
          AND d.status IN ('Preparing', 'Scheduled', 'In Transit', 'Delivered')
     )
     AND NOT EXISTS (
       SELECT 1
         FROM delivery_items di
         JOIN order_items oi ON oi.id = di.order_item_id
        WHERE oi.order_id = o.id
     )
), candidate_delivery AS (
  SELECT DISTINCT ON (d.order_id) d.id, d.order_id
    FROM deliveries d
    JOIN unrepresented_legacy_order o ON o.order_id = d.order_id
   WHERE d.status IN ('Preparing', 'Scheduled', 'In Transit', 'Delivered')
   ORDER BY d.order_id,
            CASE WHEN d.status = 'Delivered' THEN 0 ELSE 1 END,
            d.created_at DESC,
            d.id DESC
)
INSERT INTO delivery_items (delivery_id, order_item_id, quantity)
SELECT d.id, oi.id, oi.quantity
  FROM candidate_delivery d
  JOIN order_items oi ON oi.order_id = d.order_id
ON CONFLICT DO NOTHING;
