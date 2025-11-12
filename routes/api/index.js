import express from "express";

export default (ctx) => {
  const router = express.Router();

  router.get("/:id", (req, res) => {
    return res.json(ctx);
  });

  return router;
};
