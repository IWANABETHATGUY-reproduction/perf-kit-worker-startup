import { createCookieSessionStorage } from "react-router"

type SessionData = {
    userId: string
}

type SessionFlashData = {
    error: string
}

const { getSession, commitSession, destroySession } =
    createCookieSessionStorage<SessionData, SessionFlashData>({
        // a Cookie from `createCookie` or the CookieOptions to create one
        cookie: {
            name: "mcp_secret",

            isSigned: true,

            httpOnly: true,
            // Set to expire in year 9999 (effectively never)
            // expires: new Date("9999-12-31"),
            path: "/",
            sameSite: "lax",
            secrets: [process.env.AUTH_SECRET ?? ""],
            secure: true,
        },
    })

export { getSession, commitSession, destroySession }
