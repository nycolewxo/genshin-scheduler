const fs=require('fs');
const http=require('http');
const https=require('https');
const crypto=require('crypto');

const{client_id,client_secret,scope}=require("./auth/credentials.json");

const port = 3000;

const all_sessions=[];
const server = http.createServer();

server.on("listening", listen_handler);
server.listen(port);
function listen_handler(){
	console.log(`Now Listening on Port ${port}`);
}

server.on("request", request_handler);
function request_handler(req, res){
    console.log(`New Request from ${req.socket.remoteAddress} for ${req.url}`);
    if(req.url === "/"){
        const form = fs.createReadStream("html/index.html");
		res.writeHead(200, {"Content-Type": "text/html"})
		form.pipe(res);
    }
    else if(req.url.startsWith("/search")){
        const user_input=new URL(req.url, `https://${req.headers.host}`).searchParams;
        const selection=user_input.get("selection");
        const search=user_input.get("search");
        if(selection==null||selection===""||search==null||search===""){
            not_found(res);
            return;
        }
        const state=crypto.randomBytes(20).toString("hex");
        all_sessions.push({selection,search,state});
        redirect_to_calendar(state,res);
    }
    else if(req.url.startsWith("/receive_code")){
        const user_input=new URL(req.url,`https://${req.headers.host}`).searchParams;
        const code=user_input.get("code");
        const state=user_input.get("state");

        let session=all_sessions.find((session)=>session.state===state);
        if (code===undefined||state===undefined||session===undefined){
            not_found(res);
            return;
        }
        const{selection,search}=session;
        send_access_token_request(code,{selection,search},res);
    }
    else{
        not_found(res);
        return;
    }
}
function not_found(res){
    res.writeHead(404,{"Content-Type":"text/html"});
    res.end(`<h1>404 Not Found</h1>`);
}


function redirect_to_calendar(state,res){
    const authorization_endpoint="https://accounts.google.com/o/oauth2/auth";
    const response_type="code";
    const redirect_uri="http://localhost:3000/receive_code";
    let uri=new URLSearchParams({state,response_type,client_id,redirect_uri,scope}).toString();
    console.log(uri);
    res.writeHead(302,{Location:`${authorization_endpoint}?${uri}`}).end();
}

function send_access_token_request(code,user_input,res){
    const token_endpoint="https://accounts.google.com/o/oauth2/token";
    const grant_type="authorization_code";
    const redirect_uri="http://localhost:3000/receive_code";
    let post_data=new URLSearchParams({client_id,client_secret,code,grant_type,redirect_uri}).toString();
    let options = {
        method:'POST',
        headers:{
            "Content-Type":"application/x-www-form-urlencoded",
        },
    };
    https.request(token_endpoint,options,(token_stream)=>process_stream(token_stream,receive_access_token,user_input,res)).end(post_data);
}

function process_stream(stream,callback,...args){
	let body = "";
	stream.on("data",chunk=>body+=chunk);
	stream.on("end",()=>callback(body,...args));
}

function receive_access_token(body,user_input,res) {
    const{access_token}=JSON.parse(body);
    console.log(`access_token:${access_token}`);
    get_genshin_information(user_input,access_token,res);
}

function get_genshin_information(user_input,access_token,res){
    const{selection,search}=user_input;
    let genshin_api;
    if(selection==="character"){
        genshin_api = https.request({
            method:'GET',
            hostname:'genshin.jmp.blue',
            path:'/materials/talent-book'
        });
    }
    else if(selection==="weapon"){
        genshin_api = https.request({
            method:'GET',
            hostname:'genshin.jmp.blue',
            path:'/materials/weapon-ascension'
        });
    }
    genshin_api.on("response",genshin_stream=>process_stream(genshin_stream,receive_genshin_results,user_input,access_token,res));
    genshin_api.end();

}

function weekday_to_num(weekday_name){
    const weekdays=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const index=weekdays.indexOf(weekday_name);
    return index;
}

function receive_genshin_results(body,user_input,access_token,res){
    const material_object=JSON.parse(body);
    const{selection,search}=user_input;
    let material_name;
    let source;
    let days=[];
    for(let material_key in material_object){
        if(material_object.hasOwnProperty(material_key)){
            let material_info=material_object[material_key];
            for(let index in material_info.characters){
                if(material_info.characters[index]==search){
                    material_name=material_key;
                    source=material_info.source;
                    for(let dayIndex in material_info.availability){
                        days.push(weekday_to_num(material_info.availability[dayIndex]))
                    }
                }
            }
        }
    }
    if(material_name==null||source==null||days==null){
        not_found(res);
        res.end("No Results Found");
        return;
    }
    let info={selection,search,material_name,source,days};
    create_calendar(info,user_input,access_token,res)
}

function create_calendar(info,user_input,access_token,res){
    const calendar_endpoint="https://www.googleapis.com/calendar/v3/calendars";
    const options={
        method:'POST',
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${access_token}`,
        },
    };
    const post_data=JSON.stringify({summary: `Genshin Impact Calendar`});
    const create_cal_req=https.request(calendar_endpoint,options);
    create_cal_req.on("response",(cal_stream)=>process_stream(cal_stream,receive_calendar_response,info,access_token,res));
    create_cal_req.end(post_data);
}

function receive_calendar_response(body,info,access_token,res){
    const{summary:parent_id,id:calendar_id}=JSON.parse(body);
    create_events(info,parent_id,calendar_id,access_token,res);
}

function create_events(info,parent_id,calendar_id,access_token,res){
    const event_endpoint=`https://www.googleapis.com/calendar/v3/calendars/${calendar_id}/events`;
    const options = {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${access_token}`,
        },
    };
    let event_added_count=0;
    let curr_year=new Date().getFullYear();
    let curr_month=new Date().getMonth();
    let curr_day=new Date().getDate();
    let user_timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
    for(let day_index in info.days){
        create_event(info,day_index);
    }

    function create_event(info,day_index){
        const{search,material_name,source,days}=info;
        for(let i=0;i<6;i++){
            let date=new Date(curr_year,curr_month,curr_day+i);
            if(date.getDay()==days[day_index]){
                start_date=date.toISOString();
                end_date=new Date(curr_year, curr_month, curr_day + i + 1).toISOString();
                const post_data=JSON.stringify({summary:`${search}`,description:`go to ${source} to get ${material_name} for ${search}`,start:{dateTime:start_date,timeZone:user_timezone},end:{dateTime:end_date,timeZone:user_timezone},recurrence:["RRULE:FREQ=WEEKLY"]});
                https.request(event_endpoint,options,(event_stream)=>process_stream(event_stream,receive_event_response,res)).end(post_data);
            }
        }
    }
    function receive_event_response(body,res){
        event_added_count++;
        if(event_added_count===info.days.length) {
            res.writeHead(302,{Location:`https://calendar.google.com/calendar/u/0/r/day`}).end();
        }
    }
}
