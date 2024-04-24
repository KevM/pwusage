ARG GO_VERSION=1.22.2
ARG BUILDPLATFORM
ARG TARGETPLATFORM
ARG TARGETOS
ARG TARGETARCH

FROM --platform=${BUILDPLATFORM:-linux/amd64} golang:${GO_VERSION}-alpine AS build
RUN apk add --no-cache git ca-certificates npm 

ARG CGO_ENABLED=0

WORKDIR /src

COPY ./go.mod ./go.sum ./
RUN go mod download
COPY . .

RUN GOOS=${TARGETOS} ;GOARCH=${TARGETARCH}; go build -ldflags="-w -s" ./cmd/pocketbase

WORKDIR /src/cmd/web-static
RUN npm install && npm run build

FROM --platform=${TARGETPLATFORM:-linux/amd64} alpine:latest
LABEL maintainer="kevm"
RUN apk add --no-cache tzdata

VOLUME /pb_data
ENV WEB_DIR "/web"
EXPOSE 8090
COPY --from=build /src/pocketbase /pocketbase
COPY --from=build /src/cmd/web-static/build /web
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
 
ENTRYPOINT [ "./pocketbase", "serve", "--http=0.0.0.0:8090"]