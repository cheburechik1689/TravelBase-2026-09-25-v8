import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

export const Route = createFileRoute("/login")({ component: LoginRedirect });

// В Telegram Mini App пользователь уже авторизован — отдельная страница входа не нужна.
function LoginRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    void navigate({ to: "/cabinet", replace: true });
  }, [navigate]);
  return null;
}
