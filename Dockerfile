FROM golang:1.22-bullseye AS builder

ARG CGO_ENABLED=0
WORKDIR /app

COPY ./go.mod ./go.sum ./
RUN go mod download
COPY . .

RUN go build /app/cmd/pocketbase

FROM scratch
ENV WEB_DIR=/web
COPY --from=builder /app/cmd/pocketbase /pocketbase
COPY --from=builder /app/cmd/web/build /web
EXPOSE 8090
CMD ["/pwusage]