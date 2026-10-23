# Single static-ish binary on distroless: small image, short cold start on Cloud Run.
FROM oven/bun:1.3.8 AS build
WORKDIR /src
COPY package.json bun.lock tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN bun install --frozen-lockfile --production
RUN bun build apps/server/src/main.ts --compile --minify --sourcemap --outfile /out/kagi

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /out/kagi /kagi
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/kagi"]
