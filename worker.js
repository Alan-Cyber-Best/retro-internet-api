export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/search") {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405);
      }

      const q = (url.searchParams.get("q") || "").trim();

      if (!q) {
        return json({ error: "Введите запрос" }, 400);
      }

      if (!env.BRAVE_API_KEY) {
        return json({
          error: "BRAVE_API_KEY не настроен"
        }, 503);
      }

      try {
        const apiUrl = new URL(
          "https://api.search.brave.com/res/v1/web/search"
        );

        apiUrl.searchParams.set("q", q);
        apiUrl.searchParams.set("count", "10");
        apiUrl.searchParams.set("safesearch", "moderate");

        const response = await fetch(apiUrl, {
          method: "GET",
          headers: {
            "Accept": "application/json",
            "X-Subscription-Token": env.BRAVE_API_KEY
          }
        });

        if (!response.ok) {
          return json({
            error: "Ошибка Brave Search API",
            status: response.status
          }, response.status);
        }

        const data = await response.json();

        const results = (data.web?.results || []).map(item => ({
          title: item.title || "",
          url: item.url || "",
          description: item.description || ""
        }));

        return json({
          query: q,
          results
        });

      } catch (error) {
        return json({
          error: "Не удалось выполнить поиск"
        }, 500);
      }
    }

    return new Response(
      "Retro Internet Search API is online!",
      {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=UTF-8"
        }
      }
    );
  }
};

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store"
      }
    }
  );
}
 
