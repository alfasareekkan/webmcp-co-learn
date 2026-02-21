import { useEffect, useRef } from "react";
import { products } from "../data/products";

/** Convert product name to slug for fallback lookup when agent passes a name-based id. */
function toSlug(s) {
  if (s == null || String(s).trim() === "") return "";
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

export function useWebMCP(cart) {
  const cartRef = useRef(cart);
  cartRef.current = cart;

  useEffect(() => {
    if (!navigator.modelContext) {
      console.warn(
        "WebMCP not available. Enable chrome://flags/#enable-webmcp-testing in Chrome 146+."
      );
      return;
    }

    const toolDefinitions = [
      {
        name: "search_products",
        description:
          "Search and browse available products in the store. Use this to find products by name, category, or to list all products. Returns product details including id, name, price, category, stock, and rating.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Search term to filter products by name or description. Leave empty to list all products.",
            },
            category: {
              type: "string",
              description:
                "Filter by product category.",
              enum: ["all", "electronics", "clothing", "accessories"],
            },
          },
        },
        execute: ({ query, category }) => {
          let results = [...products];
          if (category && category !== "all") {
            results = results.filter((p) => p.category === category);
          }
          if (query) {
            const q = query.toLowerCase();
            results = results.filter(
              (p) =>
                p.name.toLowerCase().includes(q) ||
                p.description.toLowerCase().includes(q)
            );
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  results.map((p) => ({
                    id: p.id,
                    name: p.name,
                    price: `$${p.price}`,
                    category: p.category,
                    stock: p.stock,
                    rating: p.rating,
                  })),
                  null,
                  2
                ),
              },
            ],
          };
        },
      },
      {
        name: "add_to_cart",
        description:
          "Add a product to the shopping cart. Use the exact 'id' value from search_products (e.g. prod-002). Optional quantity (defaults to 1).",
        inputSchema: {
          type: "object",
          properties: {
            productId: {
              type: "string",
              description:
                "The exact product id from search_products (e.g. prod-002). Required. Do not use a slug or product name; use the 'id' field from the search result.",
            },
            quantity: {
              type: "number",
              description:
                "Number of items to add. Defaults to 1. Must be a positive integer.",
            },
          },
          required: ["productId"],
        },
        execute: function addToCartExecutor({ productId, quantity = 1 }) {
          const id = productId != null ? String(productId).trim() : "";
          console.log("[WebMCP][add_to_cart] called with", { productId, rawType: typeof productId, normalizedId: id, quantity });
          const byId = products.find((p) => p.id === id);
          const bySlug = id ? products.find((p) => toSlug(p.name) === toSlug(id)) : null;
          const product = byId || bySlug;
          if (!product) {
            console.warn("[WebMCP][add_to_cart] product not found", { id, availableIds: products.map((p) => p.id), slugTried: toSlug(id) });
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Product "${productId}" not found. Use search_products to find valid product IDs (e.g. prod-002) or a name slug (e.g. organic-cotton-t-shirt).`,
                },
              ],
            };
          }
          console.log("[WebMCP][add_to_cart] resolved product", { productId: product.id, name: product.name, matchedBy: byId ? "id" : "slug" });
          if (quantity < 1 || !Number.isInteger(quantity)) {
            console.warn("[WebMCP][add_to_cart] invalid quantity", { quantity });
            return {
              content: [
                {
                  type: "text",
                  text: "Error: Quantity must be a positive integer.",
                },
              ],
            };
          }
          if (quantity > product.stock) {
            console.warn("[WebMCP][add_to_cart] over stock", { quantity, stock: product.stock });
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Only ${product.stock} units of "${product.name}" are in stock.`,
                },
              ],
            };
          }
          cartRef.current.addItem(product, quantity);
          console.log("[WebMCP][add_to_cart] success - added to cart", { name: product.name, quantity, cartSize: cartRef.current.items.length });
          return {
            content: [
              {
                type: "text",
                text: `Added ${quantity}x "${product.name}" ($${product.price} each) to cart.`,
              },
            ],
          };
        },
      },
      {
        name: "remove_from_cart",
        description:
          "Remove a product entirely from the shopping cart by its product ID.",
        inputSchema: {
          type: "object",
          properties: {
            productId: {
              type: "string",
              description: "The product ID to remove from the cart.",
            },
          },
          required: ["productId"],
        },
        execute: ({ productId }) => {
          const item = cartRef.current.items.find((i) => i.id === productId);
          if (!item) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Product "${productId}" is not in the cart.`,
                },
              ],
            };
          }
          cartRef.current.removeItem(productId);
          return {
            content: [
              {
                type: "text",
                text: `Removed "${item.name}" from cart.`,
              },
            ],
          };
        },
      },
      {
        name: "update_cart_quantity",
        description:
          "Update the quantity of a product already in the cart. Set quantity to 0 to remove it.",
        inputSchema: {
          type: "object",
          properties: {
            productId: {
              type: "string",
              description: "The product ID in the cart to update.",
            },
            quantity: {
              type: "number",
              description:
                "New quantity. Set to 0 to remove the item from the cart.",
            },
          },
          required: ["productId", "quantity"],
        },
        execute: ({ productId, quantity }) => {
          const item = cartRef.current.items.find((i) => i.id === productId);
          if (!item) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Product "${productId}" is not in the cart.`,
                },
              ],
            };
          }
          cartRef.current.updateQuantity(productId, quantity);
          const action = quantity === 0 ? "Removed" : `Updated to ${quantity}x`;
          return {
            content: [
              {
                type: "text",
                text: `${action} "${item.name}" in cart.`,
              },
            ],
          };
        },
      },
      {
        name: "get_cart",
        description:
          "Get the current shopping cart contents, including all items, quantities, prices, and the total amount.",
        inputSchema: {
          type: "object",
          properties: {},
        },
        execute: () => {
          const { items, cartTotal } = cartRef.current;
          if (items.length === 0) {
            return {
              content: [
                { type: "text", text: "The cart is empty." },
              ],
            };
          }
          const summary = items.map((i) => ({
            id: i.id,
            name: i.name,
            price: `$${i.price}`,
            quantity: i.quantity,
            subtotal: `$${(i.price * i.quantity).toFixed(2)}`,
          }));
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { items: summary, total: `$${cartTotal.toFixed(2)}` },
                  null,
                  2
                ),
              },
            ],
          };
        },
      },
      {
        name: "clear_cart",
        description: "Remove all items from the shopping cart at once.",
        inputSchema: {
          type: "object",
          properties: {},
        },
        execute: () => {
          cartRef.current.clearCart();
          return {
            content: [{ type: "text", text: "Cart has been cleared." }],
          };
        },
      },
      {
        name: "checkout",
        description:
          "Proceed to checkout with the current cart contents. This places the order. The cart must not be empty.",
        inputSchema: {
          type: "object",
          properties: {
            shippingMethod: {
              type: "string",
              description:
                "Shipping speed. Use 'standard' for 5-7 business days,",
              enum: ["standard"],
            },
          },
        },
        execute: ({ shippingMethod = "standard" }) => {
          const { items, cartTotal } = cartRef.current;
          if (items.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: Cannot checkout with an empty cart. Add items first.",
                },
              ],
            };
          }
          const shippingCosts = { standard: 0, express: 9.99, overnight: 19.99 };
          const shipping = shippingCosts[shippingMethod] || 0;
          const orderId = `ORD-${Date.now().toString(36).toUpperCase()}`;

          cartRef.current.setCheckoutStatus({
            orderId,
            items: items.map((i) => ({
              name: i.name,
              quantity: i.quantity,
              subtotal: i.price * i.quantity,
            })),
            subtotal: cartTotal,
            shipping,
            total: cartTotal + shipping,
            shippingMethod,
          });
          cartRef.current.clearCart();

          return {
            content: [
              {
                type: "text",
                text: `Order ${orderId} placed successfully! Subtotal: $${cartTotal.toFixed(2)}, Shipping (${shippingMethod}): $${shipping.toFixed(2)}, Total: $${(cartTotal + shipping).toFixed(2)}.`,
              },
            ],
          };
        },
      },
    ];

    navigator.modelContext.provideContext({ tools: toolDefinitions });

    return () => {
      if (navigator.modelContext?.clearContext) {
        navigator.modelContext.clearContext();
      }
    };
  }, []);
}
