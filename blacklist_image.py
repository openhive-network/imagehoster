#! /usr/bin/env python3

import sys
from urllib.parse import urlparse,urlunparse
import base58
import requests
import logging
import json
import http.client as http_client
import configparser

print(sys.argv[1])
original_url = sys.argv[1]
parsed_url = urlparse(original_url)

image_host = 'images.hive.blog'

config = configparser.ConfigParser()
config.read('config.ini')

VARNISH_HOST = config['varnish']['host']
VARNISH_PROTO = config['varnish']['proto']

CLOUDFLARE_KEY = config['cloudflare']['key']
CLOUDFLARE_ZONE = config['cloudflare']['zone']

DEBUG_HTTP = False
if DEBUG_HTTP:
    http_client.HTTPConnection.debuglevel = 1
    logging.basicConfig()
    logging.getLogger().setLevel(logging.DEBUG)
    requests_log = logging.getLogger("requests.packages.urllib3")
    requests_log.setLevel(logging.DEBUG)
    requests_log.propagate = True

if parsed_url.netloc != image_host:
    print('Expected a URL to an image on images.hive.blog')
    sys.exit(1)

if parsed_url.path[0:3] == '/p/':
    # we're dealing with a proxied image, with a URL like
    # https://images.hive.blog/p/2r8F9rJF8BjaqNYuRfKokaqfoAwLadUB7ekQrvrx3bqAqr6H7Feg4A3aGnrKSaJRbzwQ8ZHqFcyWBNXcvYXXpxpwfzAmn313AuvVjyXZjn9LGf422byw1eG8N7gWqfRKb?format=match&mode=fit
    print('It\'s a proxied image')
    proxied_url_base58 = parsed_url.path[3:]
    print('The base58 encoded image url is ', proxied_url_base58)
    proxied_url = base58.b58decode(proxied_url_base58).decode('utf-8')
    print('Decoded, it\'s ', proxied_url)
    parsed_proxied_url = urlparse(proxied_url)
    while parsed_proxied_url.netloc == image_host and parsed_proxied_url.path[0:3] == '/p/':
        # it's double-proxied image, resolve the actual image
        proxied_url_base58 = parsed_proxied_url.path[3:]
        proxied_url = base58.b58decode(proxied_url_base58).decode('utf-8')
        parsed_proxied_url = urlparse(proxied_url)
    print('Final proxied URL is', proxied_url)
    with open('blacklist.json', 'r+') as blacklist_json:
        blacklist = json.load(blacklist_json)
        if proxied_url in blacklist:
            print('URL is already blacklisted')
        else:
            blacklist.append(proxied_url)
            blacklist_json.seek(0)
            json.dump(blacklist, blacklist_json, indent = 4)
            blacklist_json.write('\n')
            blacklist_json.truncate()

    if VARNISH_HOST:
        print('purging varnish url', original_url)
        varnish_parsed_url = parsed_url._replace(netloc = VARNISH_HOST)._replace(scheme = VARNISH_PROTO)
        varnish_url = urlunparse(varnish_parsed_url)
        #print('rewritten URL is ', varnish_url)

        r = requests.request('PURGE', varnish_url)
        if r.status_code == requests.codes.ok:
            print('      success')
        else:
            print('      failure')
    if CLOUDFLARE_KEY and CLOUDFLARE_ZONE:
        print('purging cloudflare cache for url', original_url)
        cloudflare_url = 'https://api.cloudflare.com/client/v4/zones/{}/purge_cache'.format(CLOUDFLARE_ZONE)
        r = requests.post(cloudflare_url, headers = {'Authorization': 'Bearer {}'.format(CLOUDFLARE_KEY)}, json = {'files': [original_url]})
        if r.status_code == requests.codes.ok and r.json()['success']:
            print('      success')
        else:
            print('      failure')
            print(r, r.headers, r.text)


#https://images.hive.blog/p/2r8F9rJF8BjaqNYuRfKokaqfoAwLadUB7ekQrvrx3bqAqr6H7Feg4A3aGnrKSaJRbzwQ8ZHqFcyWBNXcvYXXpxpwfzAmn313AuvVjyXZjn9LGf422byw1eG8N7gWqfRKb?format=match&mode=fit
#ParseResult(scheme='https', netloc='images.hive.blog', path='/p/2r8F9rJF8BjaqNYuRfKokaqfoAwLadUB7ekQrvrx3bqAqr6H7Feg4A3aGnrKSaJRbzwQ8ZHqFcyWBNXcvYXXpxpwfzAmn313AuvVjyXZjn9LGf422byw1eG8N7gWqfRKb', params='', query='format=match&mode=fit', fragment='')
