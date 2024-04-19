ARG GO_VERSION=1.22.2

FROM golang:${GO_VERSION}-alpine AS build
RUN apk add --no-cache git
RUN apk --no-cache add ca-certificates

ARG CGO_ENABLED=0

WORKDIR /src

COPY ./go.mod ./go.sum ./
RUN go mod download
COPY . .

# Run tests
#RUN CGO_ENABLED=0 go test -timeout 30s -v github.com/kevm/pw-usage/go-template/pkg/api
 
RUN CGO_ENABLED=0 GOOS=linux go build -o app /src/cmd/pocketbase 

#RUN go build /app/cmd/pocketbase

FROM alpine as final
LABEL maintainer="kevm"
RUN apk add --no-cache tzdata

VOLUME /pb_data
ENV WEB_DIR "/web"
EXPOSE 8090

# copy 
COPY --from=build /src/app /app
COPY --from=build /src/cmd/web/build /web
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
 
CMD ["/app", "serve", "--http=0.0.0.0:8090"]